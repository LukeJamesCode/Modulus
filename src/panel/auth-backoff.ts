// Per-IP auth-failure backoff for the panel API.
//
// The token compare is already constant-time (auth.ts), so a single wrong guess
// leaks nothing. This caps the RATE of guesses from one source: after
// `maxFailures` bad tokens from an IP within `windowMs`, that IP is blocked for
// `blockMs` — correct tokens included, because at that point the source is
// hammering, not fat-fingering. It exists for the LAN-bind case (panel on
// 0.0.0.0); on loopback there's no remote attacker and the threshold is high
// enough that a human pasting a wrong token a few times never trips it. Only
// FAILURES count — the browser's normal API traffic uses the valid token and
// records successes, which clear the counter — so a legitimate user can't lock
// themselves out by loading the page.

export interface AuthBackoffOptions {
  // Bad tokens from one IP within the window before it's blocked.
  maxFailures?: number;
  // Sliding window the failures are counted in (ms).
  windowMs?: number;
  // How long an IP stays blocked once tripped (ms).
  blockMs?: number;
  // Cap on tracked IPs, so a spray from many sources can't grow the map without
  // bound. The oldest entry is evicted past this.
  maxEntries?: number;
  now?: () => number;
}

export interface AuthBackoff {
  // Consult before checking the token. retryAfterMs is 0 unless blocked.
  check(ip: string): { blocked: boolean; retryAfterMs: number };
  recordFailure(ip: string): void;
  recordSuccess(ip: string): void;
}

interface Entry {
  failures: number;
  windowStart: number;
  blockedUntil: number;
}

export function createAuthBackoff(opts: AuthBackoffOptions = {}): AuthBackoff {
  const maxFailures = opts.maxFailures ?? 15;
  const windowMs = opts.windowMs ?? 60_000;
  const blockMs = opts.blockMs ?? 60_000;
  const maxEntries = opts.maxEntries ?? 4096;
  const now = opts.now ?? Date.now;
  const entries = new Map<string, Entry>();

  function evictIfNeeded(): void {
    if (entries.size <= maxEntries) return;
    // Map preserves insertion order; drop the oldest.
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) entries.delete(oldest);
  }

  return {
    check(ip) {
      const e = entries.get(ip);
      if (e && e.blockedUntil > now()) {
        return { blocked: true, retryAfterMs: e.blockedUntil - now() };
      }
      return { blocked: false, retryAfterMs: 0 };
    },
    recordFailure(ip) {
      const t = now();
      let e = entries.get(ip);
      if (!e || t - e.windowStart > windowMs) {
        e = { failures: 0, windowStart: t, blockedUntil: 0 };
        entries.set(ip, e);
      }
      e.failures += 1;
      if (e.failures >= maxFailures) {
        e.blockedUntil = t + blockMs;
        // Start a fresh window after the block elapses.
        e.failures = 0;
        e.windowStart = t;
      }
      evictIfNeeded();
    },
    recordSuccess(ip) {
      // A correct token from this IP clears its failure history — but not an
      // active block (a source mid-block doesn't get a free pass by guessing
      // right once before the block expires).
      const e = entries.get(ip);
      if (e && e.blockedUntil > now()) return;
      entries.delete(ip);
    },
  };
}
