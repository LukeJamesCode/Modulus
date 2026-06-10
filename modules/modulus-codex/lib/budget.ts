// Daily Codex-call budget. The whole point of the dual-system design is to keep
// most work on the free local model and spend ChatGPT-subscription quota only
// on the hard turns — so every handoff is metered against a per-day ceiling.
//
// The ledger is the `codex_calls` table (see migrations/0001). We bucket by a
// local-date string so the ceiling resets at the user's midnight, not UTC's.

import type { DB } from '../../../src/storage/db.js';

// Local YYYY-MM-DD for `now`, in the given IANA tz (system tz when omitted).
// en-CA formats as YYYY-MM-DD, which sorts and compares cleanly as a bucket key.
export function localDay(now: number, timeZone?: string): string {
  const opts: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  };
  if (timeZone) opts.timeZone = timeZone;
  try {
    return new Intl.DateTimeFormat('en-CA', opts).format(new Date(now));
  } catch {
    // Bad tz string → fall back to system local.
    return new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(now));
  }
}

export interface DayUsage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
}

// Successful + errored calls both count against the ceiling (a failed call
// still consumed an attempt and may have cost backend quota). Refusals
// ('denied') are recorded for visibility but excluded from the count so a user
// who hits the ceiling isn't permanently locked out by the refusal rows
// themselves.
export function countToday(db: DB, day: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM codex_calls WHERE day = ? AND status != 'denied'`)
    .get(day) as { n: number };
  return row.n;
}

export function usageToday(db: DB, day: string): DayUsage {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS calls,
              COALESCE(SUM(prompt_tokens), 0) AS pt,
              COALESCE(SUM(completion_tokens), 0) AS ct
         FROM codex_calls
        WHERE day = ? AND status != 'denied'`,
    )
    .get(day) as { calls: number; pt: number; ct: number };
  return { calls: row.calls, promptTokens: row.pt, completionTokens: row.ct };
}

export interface RecordArgs {
  day: string;
  chatId?: number;
  source: 'tool' | 'command';
  status: 'ok' | 'error' | 'denied';
  promptTokens?: number;
  completionTokens?: number;
  now?: number;
}

export function recordCall(db: DB, args: RecordArgs): void {
  db.prepare(
    `INSERT INTO codex_calls (day, chat_id, source, status, prompt_tokens, completion_tokens, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    args.day,
    args.chatId ?? null,
    args.source,
    args.status,
    args.promptTokens ?? null,
    args.completionTokens ?? null,
    args.now ?? Date.now(),
  );
}

export function remainingToday(db: DB, ceiling: number, day: string): number {
  return Math.max(0, ceiling - countToday(db, day));
}
