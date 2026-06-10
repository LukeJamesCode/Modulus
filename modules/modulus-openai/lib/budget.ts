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

export interface EndpointUsage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export function usageToday(db: DB, day: string, endpointAlias: string): EndpointUsage {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS calls,
              COALESCE(SUM(prompt_tokens), 0) AS pt,
              COALESCE(SUM(completion_tokens), 0) AS ct
         FROM openai_compat_usage
        WHERE day = ? AND endpoint_alias = ? AND status != 'denied'`,
    )
    .get(day, endpointAlias) as { calls: number; pt: number; ct: number };
  return {
    calls: row.calls,
    promptTokens: row.pt,
    completionTokens: row.ct,
    totalTokens: row.pt + row.ct,
  };
}

export interface UsageRow extends EndpointUsage {
  endpointAlias: string;
}

export function usageByEndpointToday(db: DB, day: string): UsageRow[] {
  const rows = db
    .prepare(
      `SELECT endpoint_alias AS endpointAlias,
              COUNT(*) AS calls,
              COALESCE(SUM(prompt_tokens), 0) AS promptTokens,
              COALESCE(SUM(completion_tokens), 0) AS completionTokens
         FROM openai_compat_usage
        WHERE day = ? AND status != 'denied'
        GROUP BY endpoint_alias
        ORDER BY endpoint_alias`,
    )
    .all(day) as Array<{
    endpointAlias: string;
    calls: number;
    promptTokens: number;
    completionTokens: number;
  }>;
  return rows.map((row) => ({
    ...row,
    totalTokens: row.promptTokens + row.completionTokens,
  }));
}

export interface RecordArgs {
  day: string;
  endpointAlias: string;
  chatId?: number;
  source: 'llm' | 'command';
  status: 'ok' | 'error' | 'denied';
  promptTokens?: number;
  completionTokens?: number;
  now?: number;
}

export function recordCall(db: DB, args: RecordArgs): void {
  db.prepare(
    `INSERT INTO openai_compat_usage
       (day, endpoint_alias, chat_id, source, status, prompt_tokens, completion_tokens, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    args.day,
    args.endpointAlias,
    args.chatId ?? null,
    args.source,
    args.status,
    args.promptTokens ?? null,
    args.completionTokens ?? null,
    args.now ?? Date.now(),
  );
}

export function assertWithinBudget(
  db: DB,
  args: {
    day: string;
    endpointAlias: string;
    dailyCallLimit?: number;
    dailyTokenLimit?: number;
  },
): void {
  const used = usageToday(db, args.day, args.endpointAlias);
  if (
    args.dailyCallLimit !== undefined &&
    args.dailyCallLimit > 0 &&
    used.calls >= args.dailyCallLimit
  ) {
    throw new Error(
      `Daily budget reached for ${args.endpointAlias}: ${used.calls}/${args.dailyCallLimit} calls used today. It resets at local midnight, or raise the endpoint limit with \`modulus config modulus-openai\`.`,
    );
  }
  if (
    args.dailyTokenLimit !== undefined &&
    args.dailyTokenLimit > 0 &&
    used.totalTokens >= args.dailyTokenLimit
  ) {
    throw new Error(
      `Daily budget reached for ${args.endpointAlias}: ${used.totalTokens}/${args.dailyTokenLimit} tokens used today. It resets at local midnight, or raise the endpoint limit with \`modulus config modulus-openai\`.`,
    );
  }
}
