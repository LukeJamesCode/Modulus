// All cron jobs for modulus-assistant:
//   1. event-reminder-sweep            — nudge 15min before calendar events
//   2. reminder-sweep                  — fire one-shot reminders from the reminders table
//   3. morning-briefing                — scheduled morning brief
//   4. night-briefing                  — scheduled evening brief
//   5. weather-reschedule-sweep        — flag outdoor events when forecast worsens
//   6. learned-routine-sweep           — slow learner that auto-creates routine_rules
//   7. learned-routine-delivery-sweep  — per-minute delivery for active routine_rules

import type { DB } from '../../src/storage/db.js';
import type { Host } from '../../src/core/modules.js';
import type { Nudge } from '../../src/core/scheduler.js';
import { matchesCron, parseCron } from '../../src/core/cron.js';
import { getClient as getCalClient } from './helpers/calendar.js';
import { buildMorningBrief, buildNightBrief, briefingTimeZone } from './gather.js';
import { weatherRescheduleCheckNudges } from './tools/planning.js';

// Hardcoded floor — see CLAUDE.md decision to keep this internal rather than
// exposing it as a user setting. Anything below 0.7 confidence is dropped
// before the learner can auto-create a routine rule.
const LEARNED_ROUTINE_CONFIDENCE_FLOOR = 0.7;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const LEARNER_LOOKBACK_DAYS = 45;
const REMINDER_LOOKBACK_DAYS = 90;

interface ReminderRow {
  id: number;
  chat_id: number;
  text: string;
}

interface LearnedRoutineCandidate {
  patternKey: string;
  title: string;
  cron: string;
  text: string;
  confidence: number;
  evidence: Record<string, unknown>;
  sourceModules: string[];
}

interface LearnedRoutineRuleRow {
  id: number;
  chat_id: number;
  cron: string;
  text: string;
}

interface UserHourRow {
  hour: number;
  n: number;
}

interface RepeatedReminderRow {
  text: string;
  hour: number;
  n: number;
}

export function register(host: Host): void {
  host.prompts.contribute(
    'When the user asks about their schedule, prefer calling `calendar_list_events` over guessing.',
  );

  // ── 1. Event reminder sweep ─────────────────────────────────────────────────

  host.scheduler.cron('event-reminder-sweep', '*/5 * * * *', async ({ firedAt, log }) => {
    const c = getCalClient(host);
    if (!c) return [];
    const chatIds = targetNudgeChatIds(host);
    if (chatIds.length === 0) return [];
    const lookahead = Number(host.settings.get<number>('nudge_lookahead_minutes', 15));
    if (!Number.isFinite(lookahead) || lookahead <= 0) {
      log.warn('invalid nudge_lookahead_minutes; skipping event-reminder sweep', { lookahead });
      return [];
    }

    const now = firedAt;
    const horizon = new Date(now.getTime() + lookahead * 60_000);
    let events: Awaited<ReturnType<typeof c.listEvents>>;
    try {
      events = await c.listEvents({
        timeMin: now.toISOString(),
        timeMax: horizon.toISOString(),
      });
    } catch (e) {
      log.warn('calendar list failed during sweep', {
        error: e instanceof Error ? e.message : String(e),
      });
      return [];
    }

    const out: Nudge[] = [];
    for (const ev of events) {
      const startMs = new Date(ev.start).getTime();
      if (startMs < now.getTime()) continue;
      const fireMinute = Math.floor(startMs / 60_000);
      const minsAway = Math.max(0, Math.round((startMs - now.getTime()) / 60_000));
      for (const chatId of chatIds) {
        if (alreadySent(host.db, ev.id, fireMinute, chatId)) continue;
        out.push({
          chatId,
          text: `🗓 In ${minsAway}m: ${ev.summary}`,
          key: `cal:${chatId}:${ev.id}:${fireMinute}`,
          category: 'calendar',
          priority: 'normal',
          reason: 'Calendar event is starting soon',
          source: 'modulus-assistant',
          createdAt: firedAt,
          expiresAt: new Date(startMs + 30 * 60_000),
          defer: true,
        });
      }
    }
    return out;
  });

  // ── 2. Reminder sweep ───────────────────────────────────────────────────────

  host.scheduler.cron('reminder-sweep', '* * * * *', async ({ firedAt, log }) => {
    const now = firedAt.getTime();
    const rows = host.db
      .prepare(`SELECT id, chat_id, text FROM reminders WHERE fired=0 AND fire_at<=?`)
      .all(now) as ReminderRow[];

    if (rows.length === 0) return [];

    const nudges: Nudge[] = [];
    for (const row of rows) {
      host.db.prepare(`UPDATE reminders SET fired=1 WHERE id=?`).run(row.id);
      nudges.push({
        chatId: row.chat_id,
        text: `⏰ Reminder: ${row.text}`,
        key: `reminder:${row.id}`,
        category: 'reminder',
        priority: 'high',
        reason: 'Reminder reached its scheduled fire time',
        source: 'modulus-assistant',
        createdAt: firedAt,
        defer: true,
        expiresAt: new Date(now + 24 * 60 * 60_000),
      });
      log.debug('reminder fired', { id: row.id, chatId: row.chat_id });
    }
    return nudges;
  });

  // ── 3 & 4. Morning and night briefings ─────────────────────────────────────

  const morningCron = briefingCron(host, 'morning', '07:00', '1-5');
  const nightCron = briefingCron(host, 'night', '21:00', '*');
  const timeZone = briefingTimeZone(host);
  const schedulerOpts = timeZone ? { timeZone } : undefined;

  if (morningCron?.trim()) {
    host.scheduler.cron(
      'morning-briefing',
      morningCron,
      async ({ log, firedAt }) => {
        const chatIds = targetBriefingChatIds(host);
        if (chatIds.length === 0) return [];
        log.debug('sending morning briefing', { chatIds });
        try {
          const text = await buildMorningBrief(host);
          const day = firedAt.toLocaleDateString('sv', { ...(timeZone ? { timeZone } : {}) });
          return chatIds.map((chatId) => ({
            chatId,
            text,
            key: `morning-brief:${chatId}:${day}`,
            category: 'briefing',
            priority: 'normal',
            reason: 'Scheduled morning briefing',
            source: 'modulus-assistant',
            createdAt: firedAt,
            defer: true,
          }));
        } catch (e) {
          log.warn('morning briefing failed', {
            error: e instanceof Error ? e.message : String(e),
          });
          return [];
        }
      },
      schedulerOpts,
    );
  }

  if (nightCron?.trim()) {
    host.scheduler.cron(
      'night-briefing',
      nightCron,
      async ({ log, firedAt }) => {
        const chatIds = targetBriefingChatIds(host);
        if (chatIds.length === 0) return [];
        log.debug('sending night briefing', { chatIds });
        try {
          const text = await buildNightBrief(host);
          const day = firedAt.toLocaleDateString('sv', { ...(timeZone ? { timeZone } : {}) });
          return chatIds.map((chatId) => ({
            chatId,
            text,
            key: `night-brief:${chatId}:${day}`,
            category: 'briefing',
            priority: 'normal',
            reason: 'Scheduled evening briefing',
            source: 'modulus-assistant',
            createdAt: firedAt,
            defer: true,
          }));
        } catch (e) {
          log.warn('night briefing failed', { error: e instanceof Error ? e.message : String(e) });
          return [];
        }
      },
      schedulerOpts,
    );
  }

  // ── 5. Weather reschedule sweep ─────────────────────────────────────────────

  const weatherCrons = weatherRescheduleCrons(host);
  weatherCrons.forEach((cron, idx) => {
    const name =
      weatherCrons.length === 1
        ? 'weather-reschedule-sweep'
        : `weather-reschedule-sweep-${idx + 1}`;
    host.scheduler.cron(name, cron, async ({ log }) => {
      try {
        return await weatherRescheduleCheckNudges(host);
      } catch (e) {
        log.warn('weather reschedule sweep failed', {
          error: e instanceof Error ? e.message : String(e),
        });
        return [];
      }
    });
  });

  // ── 6 & 7. Learned routines (learner + per-minute delivery) ─────────────────
  // Auto-accept design: the learner writes directly into routine_rules and the
  // delivery cron fires them. There is no per-suggestion accept flow. Spam
  // ceiling is max_routines_per_week (default 3 new rules / chat / 7d), and a
  // hardcoded 0.7 confidence floor keeps low-signal patterns out.

  if (host.settings.get<boolean>('learned_routines_enabled', true)) {
    const learnerCron = host.settings
      .get<string>('learned_routines_suggestion_cron', '30 8 * * *')
      .trim();
    if (learnerCron) {
      host.scheduler.cron('learned-routine-sweep', learnerCron, async ({ firedAt, log }) => {
        const chatIds = targetNudgeChatIds(host);
        if (chatIds.length === 0) return [];
        const chatId = chatIds[0]!;
        return learnedRoutineSweep(host.db, chatId, firedAt, log, host.settings);
      });
    }

    const deliveryCron = host.settings
      .get<string>('learned_routines_delivery_cron', '* * * * *')
      .trim();
    if (deliveryCron) {
      host.scheduler.cron('learned-routine-delivery-sweep', deliveryCron, async ({ firedAt }) => {
        return dueLearnedRoutineNudges(host.db, firedAt);
      });
    }
  }
}

function weatherRescheduleCrons(host: Host): string[] {
  const legacy = host.settings.get<string>('weather_reschedule_cron');
  if (legacy?.trim()) return [legacy.trim()];
  const times = host.settings.get<string>('weather_reschedule_times', '06:00,18:00');
  if (!times?.trim()) return [];
  const crons: string[] = [];
  for (const piece of times.split(',')) {
    const cron = timeToCron(piece, '*');
    if (cron) crons.push(cron);
  }
  return crons;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function targetNudgeChatIds(host: Host): number[] {
  const configured = Number(host.settings.get<number | string>('nudge_chat_id', 0));
  if (Number.isFinite(configured) && configured !== 0) return [configured];
  return host.telegram.defaultChatId ? [host.telegram.defaultChatId] : [];
}

function targetBriefingChatIds(host: Host): number[] {
  const configured = Number(host.settings.get<number | string>('briefing_chat_id', 0));
  if (Number.isFinite(configured) && configured !== 0) return [configured];
  return host.telegram.defaultChatId ? [host.telegram.defaultChatId] : [];
}

export function briefingCron(
  host: Host,
  kind: 'morning' | 'night',
  defaultTime: string,
  days: string,
): string | null {
  const timeKey = `${kind}_time`;
  const legacyKey = `${kind}_cron`;
  const configuredTime = host.settings.get<string>(timeKey, defaultTime);
  const legacyCron = host.settings.get<string>(legacyKey);
  if (legacyCron?.trim() && configuredTime === defaultTime) return legacyCron.trim();
  return timeToCron(configuredTime, days);
}

export function timeToCron(time: string, days: string): string | null {
  if (!time.trim()) return null;
  const parsed = parseHHMM(time);
  if (!parsed) return null;
  const [h, m] = parsed;
  return `${m} ${h} * * ${days}`;
}

function parseHHMM(time: string): [number, number] | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return [hour, minute];
}

function alreadySent(db: DB, eventId: string, fireMinute: number, chatId: number): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS x FROM calendar_nudges_sent
       WHERE event_id = ? AND fire_minute = ? AND chat_id IN (?, 0)`,
    )
    .get(eventId, fireMinute, chatId) as { x: number } | undefined;
  return !!row;
}

// ── Learned-routine helpers ──────────────────────────────────────────────────

async function learnedRoutineSweep(
  db: DB,
  chatId: number,
  firedAt: Date,
  log: import('../../src/util/log.js').Logger,
  settings: import('../../src/core/modules.js').ModuleSettings,
): Promise<Nudge[]> {
  const max = Math.max(0, Number(settings.get<number>('max_routines_per_week', 3)));
  if (max === 0) return [];
  const createdThisWeek = countRulesCreatedSince(db, chatId, firedAt.getTime() - WEEK_MS);
  let remaining = max - createdThisWeek;
  if (remaining <= 0) return [];

  const candidates = discoverLearnedRoutineCandidates(db, firedAt);
  const nudges: Nudge[] = [];
  for (const c of candidates) {
    if (remaining <= 0) break;
    const ruleId = insertRuleIfNew(db, c, chatId, firedAt.getTime());
    if (ruleId === null) continue;
    remaining -= 1;
    log.info('learned routine auto-created', { ruleId, patternKey: c.patternKey });
    recordRoutineEvent(db, ruleId, chatId, 'created', c.title, firedAt.getTime());
    nudges.push({
      chatId,
      text:
        `🪄 Learned a new routine: ${c.title}\n` +
        `${c.text}\n` +
        `Say "list my learned routines" to see it, or "forget the ${c.title.toLowerCase()} routine" to remove it.`,
      key: `learned-routine-new:${ruleId}`,
      category: 'routine',
      priority: 'normal',
      reason: 'Auto-created a learned routine from observed patterns',
      source: 'modulus-assistant',
      createdAt: firedAt,
      defer: true,
    });
  }
  return nudges;
}

function dueLearnedRoutineNudges(db: DB, firedAt: Date): Nudge[] {
  const rows = db
    .prepare(`SELECT id, chat_id, cron, text FROM routine_rules WHERE status='active'`)
    .all() as LearnedRoutineRuleRow[];
  if (rows.length === 0) return [];

  const minute = Math.floor(firedAt.getTime() / 60_000) * 60_000;
  const out: Nudge[] = [];
  for (const row of rows) {
    let matches = false;
    try {
      matches = matchesCron(parseCron(row.cron), firedAt);
    } catch {
      recordRoutineEvent(db, row.id, row.chat_id, 'invalid_cron', row.cron, firedAt.getTime());
      continue;
    }
    if (!matches || learnedRoutineAlreadyDelivered(db, row.id, minute)) continue;
    recordRoutineEvent(db, row.id, row.chat_id, 'delivered', null, minute);
    out.push({
      chatId: row.chat_id,
      text: row.text,
      key: `learned-routine:${row.id}:${minute}`,
      category: 'routine',
      priority: 'normal',
      reason: 'Active learned routine reached its scheduled fire time',
      source: 'modulus-assistant',
      createdAt: firedAt,
      defer: true,
    });
  }
  return out;
}

function discoverLearnedRoutineCandidates(db: DB, now: Date): LearnedRoutineCandidate[] {
  const out: LearnedRoutineCandidate[] = [];
  const night = discoverNightScheduleCandidate(db, now);
  if (night) out.push(night);
  if (tableExists(db, 'reminders')) {
    out.push(...discoverRepeatedReminderCandidates(db, now));
  }
  const tasks = discoverTaskReviewCandidate(db, now);
  if (tasks) out.push(tasks);
  return out;
}

function discoverNightScheduleCandidate(db: DB, now: Date): LearnedRoutineCandidate | null {
  if (!tableExists(db, 'messages') || !tableExists(db, 'conversations')) return null;
  const row = db
    .prepare(
      `SELECT CAST(strftime('%H', datetime(m.created_at / 1000, 'unixepoch', 'localtime')) AS INTEGER) AS hour,
              COUNT(*) AS n
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE m.role='user'
         AND m.created_at >= ?
         AND (
           lower(m.content) GLOB '*tomorrow*schedule*'
           OR lower(m.content) GLOB '*schedule*tomorrow*'
           OR lower(m.content) GLOB '*tomorrow*calendar*'
         )
       GROUP BY hour
       ORDER BY n DESC, hour DESC
       LIMIT 1`,
    )
    .get(now.getTime() - LEARNER_LOOKBACK_DAYS * 24 * 60 * 60 * 1000) as UserHourRow | undefined;
  if (!row || row.n < 3) return null;

  const confidence = Math.min(0.95, 0.45 + row.n * 0.1);
  if (confidence < LEARNED_ROUTINE_CONFIDENCE_FLOOR) return null;
  const deliveryHour = (((row.hour + 1) % 24) + 24) % 24;
  return {
    patternKey: `calendar:nightly-prep:${deliveryHour}`,
    title: 'Nightly prep brief',
    cron: `30 ${deliveryHour} * * *`,
    text: "🌙 Nightly prep: ask me for tomorrow's schedule when you're ready.",
    confidence,
    evidence: { observations: row.n, common_hour: row.hour, window_days: LEARNER_LOOKBACK_DAYS },
    sourceModules: ['modulus-assistant'],
  };
}

function discoverTaskReviewCandidate(db: DB, now: Date): LearnedRoutineCandidate | null {
  if (!tableExists(db, 'messages')) return null;
  const row = db
    .prepare(
      `SELECT CAST(strftime('%H', datetime(m.created_at / 1000, 'unixepoch', 'localtime')) AS INTEGER) AS hour,
              COUNT(*) AS n
       FROM messages m
       WHERE m.role='tool'
         AND m.tool_name IN ('tasks_list', 'tasks_add', 'tasks_complete')
         AND m.created_at >= ?
       GROUP BY hour
       ORDER BY n DESC, hour DESC
       LIMIT 1`,
    )
    .get(now.getTime() - LEARNER_LOOKBACK_DAYS * 24 * 60 * 60 * 1000) as UserHourRow | undefined;
  if (!row || row.n < 4) return null;

  const confidence = Math.min(0.9, 0.4 + row.n * 0.08);
  if (confidence < LEARNED_ROUTINE_CONFIDENCE_FLOOR) return null;
  return {
    patternKey: `tasks:review:${row.hour}`,
    title: 'Task review prompt',
    cron: `0 ${row.hour} * * 1-5`,
    text: '✅ Task review: want to check your open tasks?',
    confidence,
    evidence: { observations: row.n, common_hour: row.hour, window_days: LEARNER_LOOKBACK_DAYS },
    sourceModules: ['modulus-assistant'],
  };
}

function discoverRepeatedReminderCandidates(db: DB, now: Date): LearnedRoutineCandidate[] {
  const rows = db
    .prepare(
      `SELECT lower(trim(text)) AS text,
              CAST(strftime('%H', datetime(fire_at / 1000, 'unixepoch', 'localtime')) AS INTEGER) AS hour,
              COUNT(*) AS n
       FROM reminders
       WHERE created_at >= ?
       GROUP BY lower(trim(text)), hour
       HAVING COUNT(*) >= 3
       ORDER BY n DESC
       LIMIT 5`,
    )
    .all(now.getTime() - REMINDER_LOOKBACK_DAYS * 24 * 60 * 60 * 1000) as RepeatedReminderRow[];

  return rows.flatMap((row) => {
    const confidence = Math.min(0.9, 0.42 + row.n * 0.1);
    if (confidence < LEARNED_ROUTINE_CONFIDENCE_FLOOR) return [];
    const text = row.text.length > 80 ? `${row.text.slice(0, 77)}...` : row.text;
    return [
      {
        patternKey: `reminder:repeat:${learnedRoutineSlug(row.text)}:${row.hour}`,
        title: `Recurring reminder: ${text}`,
        cron: `0 ${row.hour} * * *`,
        text: `⏰ Routine reminder: ${text}`,
        confidence,
        evidence: {
          observations: row.n,
          common_hour: row.hour,
          window_days: REMINDER_LOOKBACK_DAYS,
        },
        sourceModules: ['modulus-assistant'],
      },
    ];
  });
}

function insertRuleIfNew(
  db: DB,
  c: LearnedRoutineCandidate,
  chatId: number,
  now: number,
): number | null {
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO routine_rules
         (pattern_key, chat_id, title, cron, text, source_modules, confidence, evidence_json, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    )
    .run(
      c.patternKey,
      chatId,
      c.title,
      c.cron,
      c.text,
      c.sourceModules.join(','),
      c.confidence,
      JSON.stringify(c.evidence),
      now,
      now,
    );
  return info.changes > 0 ? Number(info.lastInsertRowid) : null;
}

function countRulesCreatedSince(db: DB, chatId: number, sinceMs: number): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM routine_rules WHERE chat_id=? AND created_at >= ?`)
    .get(chatId, sinceMs) as { n: number } | undefined;
  return row?.n ?? 0;
}

function learnedRoutineAlreadyDelivered(db: DB, ruleId: number, minute: number): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS x FROM routine_events WHERE rule_id=? AND event_type='delivered' AND event_at=? LIMIT 1`,
    )
    .get(ruleId, minute) as { x: number } | undefined;
  return !!row;
}

function recordRoutineEvent(
  db: DB,
  ruleId: number | null,
  chatId: number,
  eventType: string,
  detail: string | null,
  eventAt: number,
): void {
  if (!tableExists(db, 'routine_events')) return;
  db.prepare(
    `INSERT INTO routine_events (rule_id, chat_id, event_type, detail, event_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(ruleId, chatId, eventType, detail, eventAt);
}

function tableExists(db: DB, name: string): boolean {
  const row = db
    .prepare(`SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=? LIMIT 1`)
    .get(name) as { x: number } | undefined;
  return !!row;
}

function learnedRoutineSlug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
}
