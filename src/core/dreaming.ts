// The "dreaming" pass: one registered scheduler job that consolidates the memory
// store while the daemon is otherwise idle. Deterministic by design — no model
// call, so it costs a single transaction and stays Pi-friendly. It does two
// things, both delegated to memory.consolidate():
//   - promote facts that keep earning recall (uses ≥ threshold), so what proves
//     useful becomes harder to evict;
//   - decay extraction noise that never proved useful and has aged out, so an
//     aggressive extractor can't permanently clutter the store.
//
// Cadence defaults to nightly at 04:00 (MODULUS_DREAMING_CRON overrides). It is
// deliberately coarse: consolidation is housekeeping, not a hot path.

import { parseCron } from './cron.js';
import type { Scheduler } from './scheduler.js';
import type { MemoryStore } from './memory.js';
import type { Logger } from '../util/log.js';

export const DEFAULT_DREAMING_CRON = '0 4 * * *';
// A fact recalled into the prompt this many times has earned durability.
export const DREAMING_PROMOTE_MIN_USES = 5;
// Extraction rows never recalled within this window are pruned as noise.
export const DREAMING_MAX_STALE_MS = 30 * 24 * 60 * 60 * 1000;

export interface DreamingOptions {
  memory: MemoryStore;
  scheduler: Scheduler;
  log: Logger;
  // Gate: skip consolidation entirely when off. Resolved in start.ts from config.
  enabled: boolean;
  // Cron cadence; falls back to DEFAULT_DREAMING_CRON when unset or invalid.
  cron?: string;
}

export interface DreamingStats {
  lastDreamAt: number | null;
  dreams: number;
  promoted: number;
  decayed: number;
  cron: string;
}

export interface Dreaming {
  stats(): DreamingStats;
  // Run one pass. Public so tests (and a future manual trigger) can drive it
  // without waiting for the tick. No-op (and no counts) when disabled.
  dream(): { promoted: number; decayed: number };
}

// Validate a supplied cron, falling back to the default rather than throwing at
// boot — an operator's typo in MODULUS_DREAMING_CRON shouldn't wedge the daemon.
function resolveCron(cron: string | undefined, log: Logger): string {
  if (!cron) return DEFAULT_DREAMING_CRON;
  try {
    parseCron(cron);
    return cron;
  } catch (e) {
    log.warn('dreaming: invalid cron, using default', {
      cron,
      default: DEFAULT_DREAMING_CRON,
      error: e instanceof Error ? e.message : String(e),
    });
    return DEFAULT_DREAMING_CRON;
  }
}

export function setupDreaming(opts: DreamingOptions): Dreaming {
  const log = opts.log.child({ mod: 'dreaming' });
  const cron = resolveCron(opts.cron, log);
  let lastDreamAt: number | null = null;
  let dreams = 0;
  let promoted = 0;
  let decayed = 0;

  function dream(): { promoted: number; decayed: number } {
    if (!opts.enabled) return { promoted: 0, decayed: 0 };
    const res = opts.memory.consolidate({
      minUses: DREAMING_PROMOTE_MIN_USES,
      maxStaleMs: DREAMING_MAX_STALE_MS,
    });
    lastDreamAt = Date.now();
    dreams += 1;
    promoted += res.promoted;
    decayed += res.decayed;
    return res;
  }

  opts.scheduler.register({
    module: 'core',
    name: 'dreaming',
    cron,
    handler: async () => {
      dream();
    },
  });

  log.info('dreaming registered', { cron, enabled: opts.enabled });
  return {
    stats: () => ({ lastDreamAt, dreams, promoted, decayed, cron }),
    dream,
  };
}
