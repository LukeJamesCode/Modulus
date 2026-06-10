import type { DB } from '../../../src/storage/db.js';

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

export function usageToday(db: DB, day: string): DayUsage {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS calls,
              COALESCE(SUM(prompt_tokens), 0) AS pt,
              COALESCE(SUM(completion_tokens), 0) AS ct
         FROM minimax_calls
        WHERE day = ? AND status != 'denied'`,
    )
    .get(day) as { calls: number; pt: number; ct: number };
  return { calls: row.calls, promptTokens: row.pt, completionTokens: row.ct };
}

export interface RecordArgs {
  day: string;
  chatId?: number;
  source: 'tool' | 'command' | 'provider';
  status: 'ok' | 'error' | 'denied';
  promptTokens?: number;
  completionTokens?: number;
  now?: number;
}

export function recordCall(db: DB, args: RecordArgs): void {
  db.prepare(
    `INSERT INTO minimax_calls (day, chat_id, source, status, prompt_tokens, completion_tokens, created_at)
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
