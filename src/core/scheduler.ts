// Scheduler / proactive loop. The infrastructure that PLAN North Star puts in
// core: a cron tick, a registry of module-supplied jobs, a fast-cache, and
// a nudge dispatcher that pushes job output into Telegram chats.
//
// Empty until modules register against it. A fresh install has nothing to
// nudge about; installing modulus-google-calendar is what turns on calendar
// reminders.
//
// Design choices:
// - One internal tick per minute. Cron jobs are minute-granularity (per the
//   cron parser); seconds are not modelled.
// - Jobs are async. A long-running job does not stall the tick — the tick
//   just records that the job is in flight and skips it next minute if it
//   hasn't finished.
// - Jobs return Nudge[] (zero or more). The scheduler routes each nudge
//   through a `dispatch` hook the Telegram adapter wires.
// - Phase 6 polish: before dispatching, the scheduler checks per-chat quiet
//   hours / snooze, applies a cross-module rate limit so calendar +
//   journal + habits can't pile three pings into the same minute, and
//   persists dedup keys so a process restart doesn't double-fire reminders.

import { matchesCron, parseCron } from './cron.js';
import type { Logger } from '../util/log.js';
import type { PrefsStore, QuietReason } from './prefs.js';
import type { DB } from '../storage/db.js';
import { createFastCache, type FastCache, type FastCacheStats } from './fast-cache.js';

export type NudgePriority = 'low' | 'normal' | 'high';

export interface NudgeAction {
  // Human-readable button label. Telegram adapters can render this as inline UI.
  label: string;
  // Telegram-compatible callback payload for in-process actions.
  callbackData?: string;
  // External link action. Telegram renders this as a URL button.
  url?: string;
  // Slash command to run later. Adapters can map this to callbackData today and
  // richer command routing later without module-specific Telegram glue.
  command?: string;
}

export interface Nudge {
  // Telegram chat id to send to. The scheduler does not infer this — the job
  // declares which chat the nudge belongs to.
  chatId: number;
  text: string;
  // Idempotency key. The dispatcher remembers keys it has already sent within
  // a TTL so a re-fired job (e.g. the bot restarted mid-tick) cannot double-
  // post the same reminder.
  key?: string;
  // Human-readable reason metadata shown by /why. Modules should keep this
  // short and non-secret because it is persisted in nudge_log for audit.
  reason?: string;
  // Self-description so core scheduling policy can coordinate nudges across
  // modules without understanding each module's domain schema. Higher-
  // priority deferred nudges are retried first when a quiet/rate-limit window
  // opens.
  priority?: NudgePriority;
  category?: string;
  source?: string;
  createdAt?: Date | number | string;
  expiresAt?: Date | number | string;
  actions?: NudgeAction[];
  // If true, a quiet-hours or rate-limit block persists this nudge for a
  // later sweep instead of dropping it. Low-value pings can leave this false.
  defer?: boolean;
}

export type JobHandler = (ctx: JobContext) => Promise<Nudge[] | void>;

export interface JobContext {
  log: Logger;
  // The scheduled fire time (rounded to the minute).
  firedAt: Date;
  // The shared fast-cache, namespaced to the owning module. Useful for
  // memoizing per-tick work so a sweep that runs every minute doesn't redo
  // the same fetch when nothing has changed.
  cache: FastCache;
}

export interface ScheduledJob {
  // Owning module name; used for logs and unregister-by-module.
  module: string;
  // Human label for logs / `/status`.
  name: string;
  cron: string;
  handler: JobHandler;
  // Optional IANA timezone for matching cron fields. Defaults to the process
  // local timezone for backwards compatibility.
  timeZone?: string;
}

export type DropReason = 'dedup' | 'rate_limit' | QuietReason | 'no_dispatch';

export interface SchedulerStats {
  jobsRegistered: number;
  ticks: number;
  lastTickAt: number | null;
  nudgesSent: number;
  nudgesDropped: Record<DropReason, number>;
  cache: FastCacheStats;
}

export interface RateLimit {
  // Max nudges per chat per window across all modules. Default {max: 1,
  // windowMs: 5*60_000} — at most one ping every five minutes.
  max: number;
  windowMs: number;
}

export interface SchedulerOptions {
  log: Logger;
  // Hook called for each Nudge a job emits. The Telegram adapter wires this.
  dispatch?: (n: Nudge) => Promise<void> | void;
  // Override the clock for tests. Used both as the wall clock and as the
  // basis for `tickAt`'s scheduling.
  now?: () => Date;
  // If supplied, the scheduler checks quiet hours / snooze before dispatching
  // a nudge. Without it, nudges always go through (Phase < 6 behaviour).
  prefs?: PrefsStore;
  // If supplied, the scheduler persists dispatched nudges into nudge_log and
  // reads it for cross-module rate-limit + restart-safe dedup.
  db?: DB;
  // Cross-module rate limit. Default {max: 1, windowMs: 5*60_000}.
  rateLimit?: RateLimit;
  // Dedup TTL for nudge.key. Default 24h. Same key inside this window is
  // suppressed even after a restart (when `db` is supplied).
  dedupTtlMs?: number;
}

export interface Scheduler {
  register(job: ScheduledJob): void;
  unregisterByModule(module: string): void;
  list(): ReadonlyArray<{ module: string; name: string; cron: string }>;
  start(): void;
  stop(): void;
  // Run one synchronous tick at the supplied date. Public so tests can drive
  // the scheduler without sleeping.
  tickAt(d: Date): Promise<void>;
  // The shared fast-cache. Modules get a per-module namespaced view via
  // the host API; core code can use this raw if it wants.
  cache: FastCache;
  // For /status and the metrics file.
  stats(): SchedulerStats;
}

interface InternalJob extends ScheduledJob {
  parsed: ReturnType<typeof parseCron>;
  inFlight: boolean;
}

function toEpochMs(value: Date | number | string | undefined): number | null {
  if (value === undefined) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

const DEFAULT_DEDUP_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RATE_LIMIT: RateLimit = { max: 1, windowMs: 5 * 60_000 };
const DEFERRED_SWEEP_MODULE = 'core';
const DEFERRED_SWEEP_JOB = 'deferred-nudges-sweep';
const DEFERRED_SWEEP_LIMIT = 50;
// Backoff applied to a deferred nudge whose dispatch attempt threw, so a
// persistently-failing send (e.g. the user blocked the bot) can't be retried
// every minute indefinitely.
const DEFERRED_RETRY_BACKOFF_MS = 10 * 60_000;

type DeferrableReason = 'rate_limit' | QuietReason;

interface DispatchOptions {
  sourceDeferredId?: number;
}

interface DeferredNudgeRow {
  id: number;
  chat_id: number;
  module: string;
  job: string;
  key: string | null;
  text: string;
  priority: NudgePriority;
  expires_at: number | null;
}

export function createScheduler(opts: SchedulerOptions): Scheduler {
  const log = opts.log.child({ mod: 'scheduler' });
  const now = opts.now ?? (() => new Date());
  const jobs = new Map<string, InternalJob>(); // keyed by `${module}:${name}`
  const seenKeys = new Map<string, number>(); // dispatched-at ms (in-mem mirror of nudge_log keys)
  // Throttle the lazy GC of seenKeys below. Walking the whole map on every send
  // is O(n) for no reason; entries only need to be gone eventually (the DB is
  // the source of truth for dedup), so sweeping at most once a minute is plenty.
  const GC_MIN_INTERVAL_MS = 60_000;
  let lastGcAt = 0;
  const dedupTtlMs = opts.dedupTtlMs ?? DEFAULT_DEDUP_TTL_MS;
  const rateLimit = opts.rateLimit ?? DEFAULT_RATE_LIMIT;
  const cache = createFastCache({ now: () => now().getTime() });
  // In-flight dispatches per chat. Incremented synchronously before we await
  // the dispatch hook; decremented after. The rate-limit check sums this with
  // the persisted nudge_log count so that two jobs firing inside the same
  // Promise.all tick can't both sneak past a max=1 limit by racing.
  const pendingByChat = new Map<number, number>();
  let timer: NodeJS.Timeout | null = null;

  const stats: SchedulerStats = {
    jobsRegistered: 0,
    ticks: 0,
    lastTickAt: null,
    nudgesSent: 0,
    nudgesDropped: {
      dedup: 0,
      rate_limit: 0,
      paused: 0,
      window: 0,
      no_dispatch: 0,
    },
    cache: cache.stats(),
  };

  function key(module: string, name: string): string {
    return `${module}:${name}`;
  }

  function register(job: ScheduledJob): void {
    const k = key(job.module, job.name);
    if (jobs.has(k)) {
      throw new Error(`scheduler: job '${k}' already registered`);
    }
    const parsed = parseCron(job.cron);
    jobs.set(k, { ...job, parsed, inFlight: false });
    stats.jobsRegistered = jobs.size;
    log.debug('job registered', {
      module: job.module,
      name: job.name,
      cron: job.cron,
      timeZone: job.timeZone,
    });
  }

  function unregisterByModule(module: string): void {
    for (const [k, j] of [...jobs.entries()]) {
      if (j.module === module) jobs.delete(k);
    }
    stats.jobsRegistered = jobs.size;
  }

  function list(): ReadonlyArray<{ module: string; name: string; cron: string }> {
    return [...jobs.values()].map((j) => ({
      module: j.module,
      name: j.name,
      cron: j.cron,
    }));
  }

  function recentDedupHit(nudgeKey: string): boolean {
    const t = now().getTime();
    const seenAt = seenKeys.get(nudgeKey);
    if (seenAt !== undefined && t - seenAt < dedupTtlMs) return true;
    if (opts.db) {
      const row = opts.db
        .prepare(`SELECT 1 FROM nudge_log WHERE key = ? AND sent_at > ? LIMIT 1`)
        .get(nudgeKey, t - dedupTtlMs) as { 1: number } | undefined;
      if (row) return true;
    }
    return false;
  }

  function rateLimited(chatId: number): boolean {
    if (!opts.db) return false;
    const t = now().getTime();
    const row = opts.db
      .prepare(`SELECT COUNT(*) AS n FROM nudge_log WHERE chat_id = ? AND sent_at > ?`)
      .get(chatId, t - rateLimit.windowMs) as { n: number } | undefined;
    const pending = pendingByChat.get(chatId) ?? 0;
    return (row?.n ?? 0) + pending >= rateLimit.max;
  }

  // jobLabel is built by buildAndRunJob as `${module}:${name}` and stored
  // in nudge_log / deferred_nudges as a (module, job) pair. Splitting it
  // anywhere else is a bug — fail loud rather than silently writing empty
  // strings to columns that downstream queries filter on.
  function parseJobLabel(jobLabel: string): { module: string; job: string } {
    const idx = jobLabel.indexOf(':');
    if (idx <= 0 || idx === jobLabel.length - 1) {
      throw new Error(`malformed job label: ${JSON.stringify(jobLabel)}`);
    }
    return { module: jobLabel.slice(0, idx), job: jobLabel.slice(idx + 1) };
  }

  function recordSent(n: Nudge, jobLabel: string): void {
    const t = now().getTime();
    if (n.key) {
      seenKeys.set(n.key, t);
      // Lazy GC of the in-mem mirror, throttled (see GC_MIN_INTERVAL_MS).
      if (t - lastGcAt > GC_MIN_INTERVAL_MS) {
        lastGcAt = t;
        for (const [k, ts] of seenKeys) {
          if (t - ts > dedupTtlMs) seenKeys.delete(k);
        }
      }
    }
    if (opts.db) {
      const { module, job } = parseJobLabel(jobLabel);
      opts.db
        .prepare(
          `INSERT INTO nudge_log
           (chat_id, module, job, key, reason, sent_at,
            priority, category, source, created_at, expires_at, actions_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          n.chatId,
          module,
          job,
          n.key ?? null,
          n.reason ?? null,
          t,
          n.priority ?? null,
          n.category ?? null,
          n.source ?? null,
          toEpochMs(n.createdAt),
          toEpochMs(n.expiresAt),
          n.actions ? JSON.stringify(n.actions) : null,
        );
    }
  }

  function deferredNotBefore(reason: DeferrableReason, until?: number): number {
    if (reason === 'rate_limit') return now().getTime() + rateLimit.windowMs;
    // 'paused' or 'window' — the prefs store tells us when the quiet ends.
    // Fall back to one minute if it's open-ended (e.g. indefinite snooze)
    // so the sweep keeps probing instead of getting wedged.
    return until ?? now().getTime() + 60_000;
  }

  function persistDeferredNudge(
    n: Nudge,
    jobLabel: string,
    reason: DeferrableReason,
    notBefore: number,
    sourceDeferredId?: number,
  ): void {
    if (!opts.db) return;
    const t = now().getTime();
    const { module, job } = parseJobLabel(jobLabel);
    const expiresAt = toEpochMs(n.expiresAt);
    const priority: NudgePriority = n.priority ?? 'normal';

    // Sweep-retry path: just bump not_before so the next window picks it up,
    // rather than inserting a duplicate row.
    if (sourceDeferredId !== undefined) {
      opts.db
        .prepare(
          `UPDATE deferred_nudges SET not_before = ?, priority = ?
           WHERE id = ? AND delivered_at IS NULL`,
        )
        .run(notBefore, priority, sourceDeferredId);
      log.debug('deferred nudge re-deferred', {
        id: sourceDeferredId,
        job: jobLabel,
        reason,
        notBefore,
      });
      return;
    }

    // Dedup-by-key: keep at most one pending row per key. The unique partial
    // index on deferred_nudges (key, delivered_at IS NULL) enforces this at
    // the storage layer; refresh the existing row instead of failing.
    if (n.key) {
      const existing = opts.db
        .prepare(`SELECT id FROM deferred_nudges WHERE key = ? AND delivered_at IS NULL LIMIT 1`)
        .get(n.key) as { id: number } | undefined;
      if (existing) {
        opts.db
          .prepare(
            `UPDATE deferred_nudges
             SET not_before = ?, priority = ?, expires_at = ?, text = ?
             WHERE id = ?`,
          )
          .run(notBefore, priority, expiresAt, n.text, existing.id);
        log.debug('deferred nudge updated', {
          id: existing.id,
          key: n.key,
          job: jobLabel,
          reason,
        });
        return;
      }
    }

    opts.db
      .prepare(
        `INSERT INTO deferred_nudges
         (chat_id, module, job, key, text, priority, not_before, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        n.chatId,
        module ?? '',
        job ?? '',
        n.key ?? null,
        n.text,
        priority,
        notBefore,
        expiresAt,
        t,
      );
    log.debug('nudge deferred', {
      chatId: n.chatId,
      key: n.key,
      job: jobLabel,
      priority,
      reason,
      notBefore,
    });
  }

  function deferIfRequested(
    n: Nudge,
    jobLabel: string,
    reason: DeferrableReason,
    notBefore: number,
    sourceDeferredId?: number,
  ): void {
    if (!n.defer) return;
    persistDeferredNudge(n, jobLabel, reason, notBefore, sourceDeferredId);
  }

  async function dispatchNudge(
    n: Nudge,
    jobLabel: string,
    dispatchOpts: DispatchOptions = {},
  ): Promise<'sent' | 'deferred' | 'dropped'> {
    if (n.key && recentDedupHit(n.key)) {
      stats.nudgesDropped.dedup += 1;
      log.debug('nudge deduped', { key: n.key, job: jobLabel });
      return 'dropped';
    }
    if (opts.prefs) {
      const q = opts.prefs.isQuiet(n.chatId, now());
      if (q.quiet && q.reason) {
        stats.nudgesDropped[q.reason] += 1;
        deferIfRequested(
          n,
          jobLabel,
          q.reason,
          deferredNotBefore(q.reason, q.until),
          dispatchOpts.sourceDeferredId,
        );
        log.debug('nudge suppressed by quiet hours', {
          chatId: n.chatId,
          reason: q.reason,
          job: jobLabel,
        });
        return 'deferred';
      }
    }
    if (rateLimited(n.chatId)) {
      stats.nudgesDropped.rate_limit += 1;
      deferIfRequested(
        n,
        jobLabel,
        'rate_limit',
        deferredNotBefore('rate_limit'),
        dispatchOpts.sourceDeferredId,
      );
      log.debug('nudge rate-limited', { chatId: n.chatId, job: jobLabel });
      return 'deferred';
    }
    if (!opts.dispatch) {
      stats.nudgesDropped.no_dispatch += 1;
      log.warn('nudge dropped: no dispatch hook', { chatId: n.chatId, job: jobLabel });
      return 'dropped';
    }
    pendingByChat.set(n.chatId, (pendingByChat.get(n.chatId) ?? 0) + 1);
    try {
      await opts.dispatch(n);
      recordSent(n, jobLabel);
      stats.nudgesSent += 1;
      return 'sent';
    } catch (e) {
      log.warn('nudge dispatch failed', {
        job: jobLabel,
        error: e instanceof Error ? e.message : String(e),
      });
      // Back off a deferred row whose dispatch *attempt* threw (e.g. the user
      // blocked the bot). Without this its not_before stays in the past and the
      // sweep retries it every single minute forever; bump it so a persistent
      // failure can't hot-loop. expires_at (when set) still eventually drops it.
      if (opts.db && dispatchOpts.sourceDeferredId !== undefined) {
        opts.db
          .prepare(
            `UPDATE deferred_nudges SET not_before = ? WHERE id = ? AND delivered_at IS NULL`,
          )
          .run(now().getTime() + DEFERRED_RETRY_BACKOFF_MS, dispatchOpts.sourceDeferredId);
      } else if (n.defer) {
        // A *fresh* deferrable nudge whose first dispatch attempt threw (a
        // transient Telegram error, not quiet hours / rate limit — those are
        // handled above before we ever dispatch). Persist it so the deferred
        // sweep retries delivery instead of dropping it. Without this a one-off
        // network blip silently loses reminders that the job already marked
        // fired and will never re-emit.
        deferIfRequested(n, jobLabel, 'rate_limit', now().getTime() + DEFERRED_RETRY_BACKOFF_MS);
      }
      return 'dropped';
    } finally {
      const cur = pendingByChat.get(n.chatId) ?? 0;
      if (cur <= 1) pendingByChat.delete(n.chatId);
      else pendingByChat.set(n.chatId, cur - 1);
    }
  }

  async function sweepDeferredNudges(): Promise<void> {
    if (!opts.db) return;
    const t = now().getTime();
    opts.db
      .prepare(
        `DELETE FROM deferred_nudges
         WHERE delivered_at IS NULL AND expires_at IS NOT NULL AND expires_at <= ?`,
      )
      .run(t);

    const rows = opts.db
      .prepare(
        `SELECT id, chat_id, module, job, key, text, priority, expires_at
         FROM deferred_nudges
         WHERE delivered_at IS NULL
           AND not_before <= ?
           AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY
           CASE priority WHEN 'high' THEN 3 WHEN 'normal' THEN 2 ELSE 1 END DESC,
           created_at ASC,
           id ASC
         LIMIT ?`,
      )
      .all(t, t, DEFERRED_SWEEP_LIMIT) as DeferredNudgeRow[];

    // SQL already orders by priority DESC, created_at ASC, id ASC — re-sorting
    // in JS would discard the created_at tiebreaker.
    for (const row of rows) {
      const status = await dispatchNudge(
        {
          chatId: row.chat_id,
          text: row.text,
          key: row.key ?? undefined,
          priority: row.priority,
          defer: true,
          expiresAt: row.expires_at ?? undefined,
        },
        `${row.module}:${row.job}`,
        { sourceDeferredId: row.id },
      );
      if (status === 'sent' || status === 'dropped') {
        opts.db
          .prepare(
            `UPDATE deferred_nudges SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL`,
          )
          .run(now().getTime(), row.id);
      }
    }
  }

  async function runJob(j: InternalJob, firedAt: Date): Promise<void> {
    if (j.inFlight) {
      log.debug('skip: job still in flight', { module: j.module, name: j.name });
      return;
    }
    j.inFlight = true;
    const jobLabel = `${j.module}:${j.name}`;
    try {
      const result = await j.handler({
        log: log.child({ job: jobLabel }),
        firedAt,
        cache: namespacedView(j.module, cache),
      });
      const nudges = Array.isArray(result) ? result : [];
      for (const n of nudges) await dispatchNudge(n, jobLabel);
    } catch (e) {
      log.warn('job failed', { job: jobLabel, error: e instanceof Error ? e.message : String(e) });
    } finally {
      j.inFlight = false;
    }
  }

  async function tickAt(d: Date): Promise<void> {
    const fire = new Date(d.getTime());
    fire.setSeconds(0, 0);
    stats.ticks += 1;
    stats.lastTickAt = fire.getTime();
    const due: InternalJob[] = [];
    for (const j of jobs.values()) {
      if (matchesCron(j.parsed, fire, j.timeZone)) due.push(j);
    }
    if (due.length === 0) return;
    await Promise.all(due.map((j) => runJob(j, fire)));
  }

  function scheduleNextTick(): void {
    // Read the clock once: computing the next-minute boundary and the delay
    // from two separate now() reads can race a clock step (NTP / mocked clock)
    // across the boundary, yielding delay 0 and a double-fire of the same
    // minute.
    const nowMs = now().getTime();
    const next = new Date(nowMs);
    next.setSeconds(0, 0);
    next.setMinutes(next.getMinutes() + 1);
    const delay = Math.max(0, next.getTime() - nowMs);
    timer = setTimeout(() => {
      void tickAt(now()).finally(() => {
        if (timer) scheduleNextTick();
      });
    }, delay);
    timer.unref?.();
  }

  function start(): void {
    if (timer) return;
    log.info('scheduler started', { jobs: jobs.size });
    scheduleNextTick();
  }

  function stop(): void {
    if (timer) clearTimeout(timer);
    timer = null;
    log.info('scheduler stopped');
  }

  function snapshotStats(): SchedulerStats {
    return {
      ...stats,
      nudgesDropped: { ...stats.nudgesDropped },
      cache: cache.stats(),
    };
  }

  if (opts.db) {
    register({
      module: DEFERRED_SWEEP_MODULE,
      name: DEFERRED_SWEEP_JOB,
      cron: '* * * * *',
      handler: async () => {
        await sweepDeferredNudges();
      },
    });
  }

  return {
    register,
    unregisterByModule,
    list,
    start,
    stop,
    tickAt,
    cache,
    stats: snapshotStats,
  };
}

// Inlined to avoid a circular import with fast-cache.ts (which knows nothing
// about the scheduler).
function namespacedView(namespace: string, base: FastCache): FastCache {
  const keys = new Set<string>();
  const p = (k: string): string => `${namespace}:${k}`;
  return {
    get: (k) => base.get(p(k)),
    set: (k, v, ttl) => {
      keys.add(p(k));
      base.set(p(k), v, ttl);
    },
    delete: (k) => {
      keys.delete(p(k));
      base.delete(p(k));
    },
    clear: () => {
      for (const k of keys) base.delete(k);
      keys.clear();
    },
    stats: () => base.stats(),
  };
}
