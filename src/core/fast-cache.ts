// Fast-cache. A small in-memory TTL cache the scheduler hands to modules
// (and core) so per-tick work doesn't recompute things every minute.
//
// Phase 6 — PLAN names this in two places:
//   • "core scheduler / proactive loop: cron tick, fast-cache, instant-facts
//     framework, nudge dispatcher" (BG-XX infrastructure, Phase 2)
//   • "Fast-cache hit-rate metrics surfaced in `modulus status`" (Phase 6)
//
// Shape kept deliberately minimal: get / set / delete + hit/miss counters.
// Eviction is purely TTL-driven, so a stale cache entry that nobody queries
// just sits there until the next access. We don't bother with LRU; the bot
// runs on Pi-class hardware where the working set is tiny anyway.

export interface FastCacheStats {
  hits: number;
  misses: number;
  size: number;
}

export interface FastCache {
  get<T = unknown>(key: string): T | undefined;
  set(key: string, value: unknown, ttlMs: number): void;
  delete(key: string): void;
  // Test-only.
  clear(): void;
  stats(): FastCacheStats;
}

interface Entry {
  value: unknown;
  expiresAt: number;
}

export interface FastCacheOptions {
  now?: () => number;
}

export function createFastCache(opts: FastCacheOptions = {}): FastCache {
  const now = opts.now ?? Date.now;
  const map = new Map<string, Entry>();
  let hits = 0;
  let misses = 0;

  function get<T>(key: string): T | undefined {
    const e = map.get(key);
    const t = now();
    if (!e || e.expiresAt <= t) {
      if (e) map.delete(key);
      misses += 1;
      return undefined;
    }
    hits += 1;
    return e.value as T;
  }

  function set(key: string, value: unknown, ttlMs: number): void {
    if (ttlMs <= 0) {
      map.delete(key);
      return;
    }
    map.set(key, { value, expiresAt: now() + ttlMs });
  }

  function del(key: string): void {
    map.delete(key);
  }

  function clear(): void {
    map.clear();
    hits = 0;
    misses = 0;
  }

  function stats(): FastCacheStats {
    return { hits, misses, size: map.size };
  }

  return { get, set, delete: del, clear, stats };
}

// Wrap a base cache so all keys are prefixed with `<namespace>:`. Stats are
// shared with the base — that's intentional: the metrics file reports a
// single hit-rate for the whole process, not per-module.
export function namespacedCache(namespace: string, base: FastCache): FastCache {
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
