// The durable Activity record (migration 0039).
//
// An append-only headline log of what Modulus did, read by the panel's Activity
// tab as a timeline (counts bucketed over time) and a feed (newest-first rows).
// Each row links back to the existing detail it summarises (a task, a routine)
// via (refTable, refId) instead of copying the transcript — the detail tables
// stay the source of truth, this is just a fast, queryable index over them.
//
// Writers live at a few choke points (a finished agent run, an answered chat
// turn, a routine fire, a confirm/owner-tier tool call) and call record() AFTER
// the user-facing work is done. record() must never throw into that hot path,
// so call sites use recordActivitySafe() rather than record() directly.

import type { DB } from '../storage/db.js';
import type { Logger } from '../util/log.js';

// Why an event ran — the timeline colours its bands by this.
export type ActivityTrigger = 'user' | 'schedule' | 'chat' | 'delegation';
// How it went — the feed's status chip.
export type ActivityStatus = 'ok' | 'failed' | 'blocked' | 'awaiting';

export interface Activity {
  id: number;
  ts: number;
  kind: string;
  actor: string;
  trigger: ActivityTrigger;
  status: ActivityStatus;
  summary: string;
  surface: string | null;
  refTable: string | null;
  refId: number | null;
  createdAt: number;
}

export interface RecordActivityInput {
  kind: string;
  actor: string;
  trigger: ActivityTrigger;
  status: ActivityStatus;
  summary: string;
  // Defaults to now() — pass the real finish time when backdating a row whose
  // work completed before we got around to recording it.
  ts?: number;
  surface?: string | null;
  refTable?: string | null;
  refId?: number | null;
}

export interface ListActivityQuery {
  // Inclusive lower / exclusive upper bound on ts (ms epoch).
  since?: number;
  until?: number;
  kind?: string;
  // Newest-first cap. Defaults to 100, clamped to [1, 500].
  limit?: number;
}

// One time bucket in the timeline: counts split by trigger (for the colour
// bands) plus a failed total (for the red mark). `start` is the bucket's left
// edge in ms epoch.
export interface TimelineBucket {
  start: number;
  total: number;
  failed: number;
  byTrigger: Record<ActivityTrigger, number>;
}

export interface TimelineQuery {
  // How far back to look, in days. Defaults to 7, clamped to [1, 90].
  days?: number;
  // Bucket width. 'hour' (default) or 'day'.
  bucket?: 'hour' | 'day';
}

export interface ActivityStore {
  record(input: RecordActivityInput): Activity;
  list(query?: ListActivityQuery): Activity[];
  timeline(query?: TimelineQuery): { bucketMs: number; buckets: TimelineBucket[] };
}

interface ActivityRow {
  id: number;
  ts: number;
  kind: string;
  actor: string;
  trigger: string;
  status: string;
  summary: string;
  surface: string | null;
  ref_table: string | null;
  ref_id: number | null;
  created_at: number;
}

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const TRIGGERS: readonly ActivityTrigger[] = ['user', 'schedule', 'chat', 'delegation'];

function rowToActivity(r: ActivityRow): Activity {
  return {
    id: r.id,
    ts: r.ts,
    kind: r.kind,
    actor: r.actor,
    trigger: r.trigger as ActivityTrigger,
    status: r.status as ActivityStatus,
    summary: r.summary,
    surface: r.surface,
    refTable: r.ref_table,
    refId: r.ref_id,
    createdAt: r.created_at,
  };
}

function clampInt(v: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(v)));
}

export function createActivityStore(db: DB): ActivityStore {
  const insert = db.prepare(
    `INSERT INTO activity (ts, kind, actor, trigger, status, summary, surface, ref_table, ref_id, created_at)
     VALUES (@ts, @kind, @actor, @trigger, @status, @summary, @surface, @ref_table, @ref_id, @created_at)`,
  );
  const selectById = db.prepare(`SELECT * FROM activity WHERE id = ?`);

  return {
    record(input) {
      const now = Date.now();
      const info = insert.run({
        ts: input.ts ?? now,
        kind: input.kind,
        actor: input.actor,
        trigger: input.trigger,
        status: input.status,
        summary: input.summary,
        surface: input.surface ?? null,
        ref_table: input.refTable ?? null,
        ref_id: input.refId ?? null,
        created_at: now,
      });
      return rowToActivity(selectById.get(Number(info.lastInsertRowid)) as ActivityRow);
    },

    list(query = {}) {
      const limit = clampInt(query.limit ?? 100, 1, 500, 100);
      const where: string[] = [];
      const params: Record<string, number | string> = { limit };
      if (typeof query.since === 'number') {
        where.push('ts >= @since');
        params['since'] = query.since;
      }
      if (typeof query.until === 'number') {
        where.push('ts < @until');
        params['until'] = query.until;
      }
      if (query.kind) {
        where.push('kind = @kind');
        params['kind'] = query.kind;
      }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const rows = db
        .prepare(`SELECT * FROM activity ${clause} ORDER BY ts DESC, id DESC LIMIT @limit`)
        .all(params) as ActivityRow[];
      return rows.map(rowToActivity);
    },

    timeline(query = {}) {
      const days = clampInt(query.days ?? 7, 1, 90, 7);
      const bucketMs = query.bucket === 'day' ? DAY_MS : HOUR_MS;
      const since = Date.now() - days * DAY_MS;
      // Group once in SQL by (bucket, trigger, status); assemble the per-bucket
      // shape in JS so the colour split + failed count come from one scan.
      const grouped = db
        .prepare(
          // CAST both sides to INTEGER so SQLite does integer (floor) division —
          // a bound JS number can arrive as REAL, which would split one hour
          // into many fractional buckets.
          `SELECT (CAST(ts AS INTEGER) / CAST(@bucketMs AS INTEGER)) AS b, trigger, status, COUNT(*) AS n
             FROM activity
            WHERE ts >= @since
            GROUP BY b, trigger, status`,
        )
        .all({ bucketMs, since }) as Array<{ b: number; trigger: string; status: string; n: number }>;

      const byBucket = new Map<number, TimelineBucket>();
      for (const g of grouped) {
        const start = g.b * bucketMs;
        let bkt = byBucket.get(start);
        if (!bkt) {
          bkt = { start, total: 0, failed: 0, byTrigger: { user: 0, schedule: 0, chat: 0, delegation: 0 } };
          byBucket.set(start, bkt);
        }
        bkt.total += g.n;
        if (g.status === 'failed' || g.status === 'blocked') bkt.failed += g.n;
        if (TRIGGERS.includes(g.trigger as ActivityTrigger)) {
          bkt.byTrigger[g.trigger as ActivityTrigger] += g.n;
        }
      }
      const buckets = [...byBucket.values()].sort((a, b) => a.start - b.start);
      return { bucketMs, buckets };
    },
  };
}

// Record without ever throwing into the caller's hot path. The Activity log is
// observability — a failed insert must never break the chat turn / agent run /
// routine fire that produced the event. Logs at debug and moves on.
export function recordActivitySafe(
  store: ActivityStore | undefined,
  log: Logger | undefined,
  input: RecordActivityInput,
): void {
  if (!store) return;
  try {
    store.record(input);
  } catch (e) {
    log?.debug('activity record failed', {
      kind: input.kind,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
