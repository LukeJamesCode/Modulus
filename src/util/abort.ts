// Combine N AbortSignals into one. Aborts when any input aborts.
//
// Prefer the platform combinator (`AbortSignal.any`, Node >= 20.3): it holds
// the source signals weakly, so the composed signal and its listeners are
// reclaimed when the round ends instead of piling up on a long-lived per-turn
// signal reused across tool rounds / handoffs. The manual fallback (older
// runtimes) tears its own listeners down once any source fires, so the
// survivors don't linger on the shared signal.
export function composeAbort(...signals: AbortSignal[]): AbortSignal {
  const anyFn = (AbortSignal as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === 'function') return anyFn(signals);

  const ctl = new AbortController();
  const cleanups: Array<() => void> = [];
  const finish = (reason: unknown): void => {
    for (const c of cleanups.splice(0)) c();
    ctl.abort(reason);
  };
  for (const s of signals) {
    if (s.aborted) {
      finish(s.reason);
      break;
    }
    const onAbort = (): void => finish(s.reason);
    s.addEventListener('abort', onAbort, { once: true });
    cleanups.push(() => s.removeEventListener('abort', onAbort));
  }
  return ctl.signal;
}
