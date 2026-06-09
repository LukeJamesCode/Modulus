// Metrics snapshot writer.
//
// `modulus status` is a one-shot CLI that runs in a separate process from the
// running daemon, so it can't read live counters from the scheduler. Instead
// the daemon writes a small `metrics.json` snapshot under ~/.modulus/ on a
// timer; `modulus status` reads it. The file is best-effort — missing or
// stale-by-many-minutes is fine, the CLI just notes that.
//
// Phase 6: started here so /status (Telegram) and `modulus status` (CLI) both
// surface the fast-cache hit rate and nudge counters.

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Logger } from '../util/log.js';
import { ensurePrivateDir, ensurePrivateFile } from '../cli/config-store.js';
import type { Scheduler, SchedulerStats } from './scheduler.js';

export interface MetricsSnapshot {
  updatedAt: number;
  startedAt: number;
  uptimeMs: number;
  scheduler: SchedulerStats;
}

export interface MetricsWriterOptions {
  path: string;
  log: Logger;
  scheduler: Scheduler;
  startedAt: number;
  // Defaults to 60s. Tests pass a smaller value or 0 for one-shot.
  intervalMs?: number;
  // Test seam.
  now?: () => number;
}

export interface MetricsWriter {
  writeOnce(): void;
  start(): void;
  stop(): void;
}

export function createMetricsWriter(opts: MetricsWriterOptions): MetricsWriter {
  const log = opts.log.child({ mod: 'metrics' });
  const interval = opts.intervalMs ?? 60_000;
  const now = opts.now ?? Date.now;
  let timer: NodeJS.Timeout | null = null;

  function snapshot(): MetricsSnapshot {
    const t = now();
    return {
      updatedAt: t,
      startedAt: opts.startedAt,
      uptimeMs: t - opts.startedAt,
      scheduler: opts.scheduler.stats(),
    };
  }

  function writeOnce(): void {
    try {
      ensurePrivateDir(dirname(opts.path));
      writeFileSync(opts.path, JSON.stringify(snapshot()), { mode: 0o600 });
      ensurePrivateFile(opts.path);
    } catch (e) {
      log.debug('metrics write failed', { error: e instanceof Error ? e.message : String(e) });
    }
  }

  function start(): void {
    if (timer) return;
    writeOnce();
    timer = setInterval(writeOnce, interval);
    timer.unref?.();
  }

  function stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { writeOnce, start, stop };
}

// Best-effort read for the CLI. Returns null if the file is missing or
// unparseable; the caller decides how to surface that.
export function readMetrics(path: string): MetricsSnapshot | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as MetricsSnapshot;
  } catch {
    return null;
  }
}
