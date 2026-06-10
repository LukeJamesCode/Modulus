// Auto-reschedule lifecycle for outdoor calendar events when the forecast
// turns bad. The weather sweep (jobs.ts) calls `openProposal` to create a
// row and emit a Yes/No nudge; the inline-button callbacks below walk the
// proposal through propose → accept → move event, or decline-and-retry, or
// forget. All state lives in the `reschedule_proposals` table so a restart
// resumes the same flow.
//
// Callback prefix: `wxr` (weather reschedule). Payloads:
//   wxr:yes:<id>        — user agreed to look for a slot
//   wxr:no:<id>         — user declined the initial prompt; drop the proposal
//   wxr:accept:<id>     — user accepted the proposed slot; move the event
//   wxr:retry:<id>      — user wants another slot; remember the rejected one
//   wxr:forget:<id>     — user is done; drop the proposal

import type { Host } from '../../../src/core/modules.js';
import type { Nudge, NudgeAction } from '../../../src/core/scheduler.js';
import type { DB } from '../../../src/storage/db.js';
import { getClient as getCalClient } from '../helpers/calendar.js';
import { findFreeSlotsInternal, type FreeSlot } from './planning.js';

const CB_PREFIX = 'wxr';

// Hard cap on how many slots a user can decline before we give up and drop
// the proposal. Keeps a runaway "no, no, no…" loop from churning the API.
const MAX_DECLINED_SLOTS = 6;

// How many days ahead the slot search will scan when looking for a free
// replacement window. The first day that yields at least one open slot wins.
const SLOT_SEARCH_DAYS = 7;

export interface ProposalRow {
  id: number;
  chat_id: number;
  event_id: string;
  event_summary: string | null;
  original_start: string;
  original_end: string;
  status: 'pending' | 'proposed' | 'accepted' | 'rejected' | 'forgotten' | 'failed';
  declined_slots_json: string;
  proposed_start: string | null;
  proposed_end: string | null;
  reason: string | null;
  created_at: number;
  updated_at: number;
}

export function register(host: Host): void {
  host.telegram.onCallback(CB_PREFIX, async (cctx) => {
    const parts = cctx.data.split(':');
    const action = parts[0];
    const idStr = parts[1];
    const id = Number(idStr);
    if (!action || !Number.isInteger(id) || id <= 0) {
      await cctx.ack();
      return;
    }
    const prop = loadProposal(host.db, id);
    if (!prop || prop.chat_id !== cctx.chatId) {
      // Either deleted, expired, or a different chat clicked a stale button.
      // Edit the message so the buttons stop tempting future clicks.
      await cctx.ack();
      await cctx.editMessage("This reschedule prompt isn't active anymore.");
      return;
    }

    switch (action) {
      case 'yes':
        await handleYes(host, prop, cctx);
        return;
      case 'no':
        await handleNo(host, prop, cctx);
        return;
      case 'accept':
        await handleAccept(host, prop, cctx);
        return;
      case 'retry':
        await handleRetry(host, prop, cctx);
        return;
      case 'forget':
        await handleForget(host, prop, cctx);
        return;
      default:
        await cctx.ack();
        return;
    }
  });
}

// ── Public surface for jobs.ts ──────────────────────────────────────────────

// Create a pending proposal for a flagged event and return the nudge to send.
// Returns null when an open proposal for this event already exists — the
// dedup keeps the sweep from spamming the same event every cron tick.
export function openProposal(
  db: DB,
  args: {
    chatId: number;
    eventId: string;
    eventSummary: string;
    eventStart: string;
    eventEnd: string;
    reason: string;
  },
  now: number = Date.now(),
): { proposalId: number; nudge: Nudge } | null {
  const existing = db
    .prepare(
      `SELECT id FROM reschedule_proposals
       WHERE chat_id = ? AND event_id = ? AND status IN ('pending', 'proposed')
       LIMIT 1`,
    )
    .get(args.chatId, args.eventId) as { id: number } | undefined;
  if (existing) return null;

  const info = db
    .prepare(
      `INSERT INTO reschedule_proposals
         (chat_id, event_id, event_summary, original_start, original_end,
          status, declined_slots_json, reason, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', '[]', ?, ?, ?)`,
    )
    .run(
      args.chatId,
      args.eventId,
      args.eventSummary,
      args.eventStart,
      args.eventEnd,
      args.reason,
      now,
      now,
    );
  const proposalId = Number(info.lastInsertRowid);

  const timeStr = formatLocalDateTime(args.eventStart);
  const nudge: Nudge = {
    chatId: args.chatId,
    text:
      `⚠️ Weather alert for "${args.eventSummary}" at ${timeStr}.\n` +
      `${args.reason}\nWant me to reschedule it?`,
    key: `wxreschedule:${args.chatId}:${args.eventId}:${proposalId}`,
    category: 'weather',
    priority: 'normal',
    reason: 'Weather may affect an outdoor calendar event',
    source: 'modulus-assistant',
    createdAt: new Date(now),
    defer: true,
    actions: [
      { label: '✅ Yes, reschedule', callbackData: `cb:${CB_PREFIX}:yes:${proposalId}` },
      { label: '❌ No, leave it', callbackData: `cb:${CB_PREFIX}:no:${proposalId}` },
    ],
  };
  return { proposalId, nudge };
}

// ── Callback handlers ──────────────────────────────────────────────────────

async function handleYes(
  host: Host,
  prop: ProposalRow,
  cctx: import('../../../src/core/modules.js').TelegramCallbackContext,
): Promise<void> {
  await cctx.ack('Looking for a free slot…');
  await cctx.editMessage(`Looking for a free slot to move "${displaySummary(prop)}"…`);
  const slot = await pickNextSlot(host, prop);
  if (!slot) {
    setStatus(host.db, prop.id, 'failed');
    await cctx.reply(
      `Couldn't find a free slot in the next ${SLOT_SEARCH_DAYS} days. Try /quickadd or pick a time yourself.`,
    );
    return;
  }
  storeProposedSlot(host.db, prop.id, slot);
  await cctx.reply(`How about ${slot.label}?`, {
    actions: proposalActions(prop.id),
  });
}

async function handleNo(
  host: Host,
  prop: ProposalRow,
  cctx: import('../../../src/core/modules.js').TelegramCallbackContext,
): Promise<void> {
  setStatus(host.db, prop.id, 'rejected');
  await cctx.ack('Kept as-is.');
  await cctx.editMessage(`Kept "${displaySummary(prop)}" as scheduled.`);
}

async function handleAccept(
  host: Host,
  prop: ProposalRow,
  cctx: import('../../../src/core/modules.js').TelegramCallbackContext,
): Promise<void> {
  if (!prop.proposed_start || !prop.proposed_end) {
    await cctx.ack();
    await cctx.editMessage(
      'That proposal no longer has a slot attached. Start over with /weather.',
    );
    return;
  }
  const cal = getCalClient(host);
  if (!cal) {
    await cctx.ack();
    await cctx.editMessage('Google Calendar is not connected — cannot move the event.');
    return;
  }
  await cctx.ack('Moving the event…');
  try {
    // Delete + re-add. The replacement keeps the same summary but gets a new
    // event id; that's an accepted tradeoff per the design decision (no
    // updateEvent endpoint in our calendar helper today).
    const newEv = await cal.addEvent({
      summary: prop.event_summary ?? '(no title)',
      start: prop.proposed_start,
      end: prop.proposed_end,
      description: `Auto-rescheduled by Modulus from ${prop.original_start} due to weather.`,
    });
    await cal.deleteEvent(prop.event_id);
    setStatus(host.db, prop.id, 'accepted');
    await cctx.editMessage(
      `Moved "${displaySummary(prop)}" to ${formatLocalDateTime(prop.proposed_start)}. (new id ${newEv.id})`,
    );
  } catch (e) {
    setStatus(host.db, prop.id, 'failed');
    await cctx.reply(
      `Couldn't move the event: ${e instanceof Error ? e.message : String(e)}. Try moving it manually.`,
    );
  }
}

async function handleRetry(
  host: Host,
  prop: ProposalRow,
  cctx: import('../../../src/core/modules.js').TelegramCallbackContext,
): Promise<void> {
  const declined = parseDeclinedSlots(prop.declined_slots_json);
  if (prop.proposed_start && !declined.includes(prop.proposed_start)) {
    declined.push(prop.proposed_start);
  }
  if (declined.length >= MAX_DECLINED_SLOTS) {
    setStatus(host.db, prop.id, 'forgotten');
    await cctx.ack();
    await cctx.editMessage(
      `Tried ${MAX_DECLINED_SLOTS} slots without a fit — dropped this reschedule. Pick a time yourself with /quickadd.`,
    );
    return;
  }
  saveDeclinedSlots(host.db, prop.id, declined);
  await cctx.ack('Trying another slot…');
  await cctx.editMessage(`Looking for another slot for "${displaySummary(prop)}"…`);

  const next = await pickNextSlot(host, { ...prop, declined_slots_json: JSON.stringify(declined) });
  if (!next) {
    setStatus(host.db, prop.id, 'failed');
    await cctx.reply(
      `Couldn't find another free slot in the next ${SLOT_SEARCH_DAYS} days. Try /quickadd.`,
    );
    return;
  }
  storeProposedSlot(host.db, prop.id, next);
  await cctx.reply(`How about ${next.label}?`, {
    actions: proposalActions(prop.id),
  });
}

async function handleForget(
  host: Host,
  prop: ProposalRow,
  cctx: import('../../../src/core/modules.js').TelegramCallbackContext,
): Promise<void> {
  setStatus(host.db, prop.id, 'forgotten');
  await cctx.ack('Dropped.');
  await cctx.editMessage(`Forgot it — "${displaySummary(prop)}" stays put.`);
}

// ── Internals ───────────────────────────────────────────────────────────────

function proposalActions(id: number): NudgeAction[] {
  return [
    { label: '✅ Yes, move it', callbackData: `cb:${CB_PREFIX}:accept:${id}` },
    { label: '🔁 No, try another', callbackData: `cb:${CB_PREFIX}:retry:${id}` },
    { label: '🗑 Forget it', callbackData: `cb:${CB_PREFIX}:forget:${id}` },
  ];
}

// Walk the next SLOT_SEARCH_DAYS days, returning the first slot whose start
// is not already in declined_slots_json. Searches one day at a time so a busy
// "today" doesn't block "tomorrow" from showing up.
async function pickNextSlot(host: Host, prop: ProposalRow): Promise<FreeSlot | null> {
  const declined = new Set(parseDeclinedSlots(prop.declined_slots_json));
  const durationMs = Math.max(
    30 * 60_000,
    new Date(prop.original_end).getTime() - new Date(prop.original_start).getTime(),
  );
  const durationMinutes = Math.round(durationMs / 60_000);
  const baseDate = new Date(prop.original_start);

  for (let offset = 1; offset <= SLOT_SEARCH_DAYS; offset++) {
    const d = new Date(baseDate);
    d.setDate(d.getDate() + offset);
    const dateStr = isoDate(d);
    const { slots } = await findFreeSlotsInternal(host, {
      date: dateStr,
      duration_minutes: durationMinutes,
      count: 4,
    });
    for (const slot of slots) {
      if (!declined.has(slot.startIso)) return slot;
    }
  }
  return null;
}

function loadProposal(db: DB, id: number): ProposalRow | null {
  const row = db
    .prepare(
      `SELECT id, chat_id, event_id, event_summary, original_start, original_end,
              status, declined_slots_json, proposed_start, proposed_end, reason,
              created_at, updated_at
       FROM reschedule_proposals WHERE id = ?`,
    )
    .get(id) as ProposalRow | undefined;
  return row ?? null;
}

function setStatus(db: DB, id: number, status: ProposalRow['status']): void {
  db.prepare(`UPDATE reschedule_proposals SET status = ?, updated_at = ? WHERE id = ?`).run(
    status,
    Date.now(),
    id,
  );
}

function storeProposedSlot(db: DB, id: number, slot: FreeSlot): void {
  db.prepare(
    `UPDATE reschedule_proposals
       SET status = 'proposed', proposed_start = ?, proposed_end = ?, updated_at = ?
     WHERE id = ?`,
  ).run(slot.startIso, slot.endIso, Date.now(), id);
}

function saveDeclinedSlots(db: DB, id: number, slots: string[]): void {
  db.prepare(
    `UPDATE reschedule_proposals SET declined_slots_json = ?, updated_at = ? WHERE id = ?`,
  ).run(JSON.stringify(slots), Date.now(), id);
}

function parseDeclinedSlots(json: string): string[] {
  try {
    const v = JSON.parse(json);
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  } catch {
    // tolerate corruption — better to forget the declined list than crash
  }
  return [];
}

function displaySummary(prop: ProposalRow): string {
  return prop.event_summary?.trim() || 'this event';
}

function isoDate(d: Date): string {
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

function formatLocalDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
