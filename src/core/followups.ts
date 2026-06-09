// Self-scheduled followups. A small piece of agency: the model can call
// `schedule_followup` to commit to messaging the user at a future time
// ("remind me to take the chicken out at 5"). A scheduler sweep fires every
// minute, picks rows whose due_at has arrived, and emits Nudges for the
// scheduler to dispatch.
//
// Why this lives in core, not an extension:
// - It's the smallest possible step from "answers when asked" to "thinks
//   across time" — the agent gap discussion in CLAUDE.md.
// - Every extension benefits: the calendar extension can ask the model to
//   schedule a followup for an event without any extension-specific glue.
// - Extensions can still hook the lifecycle if they want (an `afterReply`
//   listener that scans the assistant turn for promises, say) but the core
//   tool gives them one consistent place to land followups.
//
// Why minute-granularity:
// - The scheduler ticks every minute (matches its cron parser). Sub-minute
//   precision would require a second timer surface; not worth it for a
//   feature whose typical horizon is hours-to-days.
// - "Remind me in 30 seconds" rounds up to the next minute, which is fine.
//
// Rate-limit + quiet-hours behaviour:
// - Followups go through the standard nudge dispatch, so they respect quiet
//   hours and the cross-extension rate limit.
// - On dispatch the row is marked `fired_at` regardless of whether it was
//   suppressed. Trade-off: a followup that lands during quiet hours is lost,
//   not retried. Acceptable for now — the alternative (re-firing every
//   minute until it lands) can spam once quiet hours end. Revisit if real
//   usage shows missed reminders matter more than one-shot semantics.

import type { DB } from '../storage/db.js';
import type { Logger } from '../util/log.js';
import type { Scheduler, Nudge } from './scheduler.js';
import type { ToolHandler, ToolRegistry } from './tools.js';

export interface FollowupsOptions {
  db: DB;
  scheduler: Scheduler;
  tools: ToolRegistry;
  log: Logger;
  // Override the clock in tests.
  now?: () => Date;
}

export interface FollowupRow {
  id: number;
  chatId: number;
  dueAt: number;
  topic: string;
  createdAt: number;
}

export interface Followups {
  // Direct-insert path for tests / future callers (e.g. an afterReply hook
  // that wants to schedule on the model's behalf without a tool round-trip).
  schedule(input: { chatId: number; dueAt: number; topic: string }): number;
  // Audit/control helpers for Telegram and future surfaces. They are chat-
  // scoped so a command can never see or mutate another chat's commitments.
  listPending(chatId: number): FollowupRow[];
  cancel(chatId: number, id: number): boolean;
  clearPending(chatId: number): number;
  // Run one sweep. Public so tests can drive it without a real tick.
  sweep(now?: Date): Nudge[];
}

const SWEEP_CRON = '* * * * *'; // every minute

export function setupFollowups(opts: FollowupsOptions): Followups {
  const log = opts.log.child({ mod: 'followups' });
  const now = opts.now ?? (() => new Date());

  function schedule(input: { chatId: number; dueAt: number; topic: string }): number {
    const t = now().getTime();
    const r = opts.db
      .prepare(`INSERT INTO followups (chat_id, due_at, topic, created_at) VALUES (?, ?, ?, ?)`)
      .run(input.chatId, input.dueAt, input.topic, t);
    log.debug('followup scheduled', {
      id: Number(r.lastInsertRowid),
      chatId: input.chatId,
      dueAt: input.dueAt,
      topic: input.topic,
    });
    return Number(r.lastInsertRowid);
  }

  function listPending(chatId: number): FollowupRow[] {
    return opts.db
      .prepare(
        `SELECT id, chat_id AS chatId, due_at AS dueAt, topic, created_at AS createdAt
         FROM followups
         WHERE chat_id = ? AND fired_at IS NULL
         ORDER BY due_at ASC, id ASC`,
      )
      .all(chatId) as FollowupRow[];
  }

  function cancel(chatId: number, id: number): boolean {
    const r = opts.db
      .prepare(`DELETE FROM followups WHERE chat_id = ? AND id = ? AND fired_at IS NULL`)
      .run(chatId, id);
    if (r.changes > 0) log.info('followup cancelled', { chatId, id });
    return r.changes > 0;
  }

  function clearPending(chatId: number): number {
    const r = opts.db
      .prepare(`DELETE FROM followups WHERE chat_id = ? AND fired_at IS NULL`)
      .run(chatId);
    if (r.changes > 0) log.info('followups cleared', { chatId, n: r.changes });
    return r.changes;
  }

  function sweep(at: Date = now()): Nudge[] {
    const t = at.getTime();
    const rows = opts.db
      .prepare(
        `SELECT id, chat_id AS chatId, topic FROM followups
         WHERE fired_at IS NULL AND due_at <= ?
         ORDER BY due_at ASC`,
      )
      .all(t) as Array<{ id: number; chatId: number; topic: string }>;
    if (rows.length === 0) return [];
    const upd = opts.db.prepare(`UPDATE followups SET fired_at = ? WHERE id = ?`);
    const nudges: Nudge[] = [];
    for (const r of rows) {
      upd.run(t, r.id);
      nudges.push({
        chatId: r.chatId,
        text: r.topic,
        // Stable dedup key in case a sweep runs twice in the same minute (it
        // shouldn't, but a process restart mid-tick could).
        key: `followup:${r.id}`,
        // The row is marked fired the moment it's swept, so without deferral a
        // followup that comes due during quiet hours / a rate-limit window — or
        // hits a transient dispatch error — would be silently dropped and never
        // re-emitted. Defer lets the scheduler persist and retry it; expiresAt
        // bounds that retry so a permanently-undeliverable chat can't accrete
        // rows forever.
        defer: true,
        expiresAt: new Date(t + 24 * 60 * 60_000),
      });
    }
    log.info('followups fired', { n: nudges.length });
    return nudges;
  }

  // Register the sweep against the core scheduler. `extension: 'core'` is
  // just a label — the scheduler doesn't gate by registered extensions.
  opts.scheduler.register({
    extension: 'core',
    name: 'followups-sweep',
    cron: SWEEP_CRON,
    handler: async ({ firedAt }) => sweep(firedAt),
  });

  // The model-facing tool. Auto-tier: scheduling a future message is
  // low-risk and can't reach external systems. We do guard against absurd
  // inputs (past times, > 1y in the future, empty topic).
  const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
  const tool: ToolHandler = {
    name: 'schedule_followup',
    // Tight intent gate. The bare word "schedule" used to be enough to expose
    // this tool, and the 0.8b/2b chat models then preferred it over
    // smart_schedule_task for prompts like "schedule the project report this
    // week". Restrict to phrasings that genuinely ask the bot to message the
    // user later, so the per-turn manifest hides it on scheduling requests.
    intentPattern:
      "\\b(check in|check on me|check back|follow ?up|followup|ping me about|remind me to|chase me|nag me|don'?t let me forget|message me about|text me about)\\b",
    description:
      "Self-issued check-in: send a future chat MESSAGE from yourself to the user, only when they explicitly ask you to follow up or check in later ('check on me about the interview tomorrow'). " +
      "The bare word 'schedule' is NOT a trigger — 'schedule the report' is `smart_schedule_task`, not this. Time = ISO 8601 future, within one year.",
    parameters: {
      type: 'object',
      required: ['when_iso', 'topic'],
      properties: {
        when_iso: {
          type: 'string',
          description:
            'ISO 8601 timestamp when to send the followup. Use the date and offset from the system prompt to resolve relative phrases.',
        },
        topic: {
          type: 'string',
          description: 'The message to send the user when the time arrives.',
        },
      },
    },
    tier: 'auto',
    selfReplying: true,
    invoke: async (args, ctx) => {
      const when = String(args['when_iso'] ?? '').trim();
      const topic = String(args['topic'] ?? '').trim();
      if (!ctx.chatId) {
        return 'Error: schedule_followup needs a chat context. This tool only works inside a Telegram conversation.';
      }
      if (!topic) {
        return 'Error: `topic` is empty. Provide the text the user should see when the followup fires.';
      }
      const due = Date.parse(when);
      if (Number.isNaN(due)) {
        return `Error: could not parse \`when_iso\` (${when}). Use ISO 8601, e.g. 2026-05-04T17:00:00-06:00.`;
      }
      const tNow = now().getTime();
      if (due <= tNow) {
        return `Error: \`when_iso\` (${when}) is in the past. Schedule a time after the current local time shown in the system prompt.`;
      }
      if (due - tNow > ONE_YEAR_MS) {
        return `Error: \`when_iso\` (${when}) is more than a year out. Pick something within a year.`;
      }
      const id = schedule({ chatId: ctx.chatId, dueAt: due, topic });
      const dueLocal = new Date(due).toLocaleString();
      return `Scheduled followup #${id} for ${dueLocal}: ${topic}`;
    },
  };
  opts.tools.register(tool);

  return { schedule, listPending, cancel, clearPending, sweep };
}
