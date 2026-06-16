// Confirm prompts parked by in-flight panel SSE turns, keyed by id. When a
// confirm-tier tool fires mid-turn the browser/DM renderer parks a prompt here;
// POST .../confirm resolves it by id, so the registry is shared across every
// live stream. Each stream takes its own scope(): when a stream ends it
// fails-closed only ITS pending prompts — a sibling tab on the same chat (or a
// concurrent DM with another agent) keeps its own waiting prompts alive.

export type ConfirmFinish = (ok: boolean) => void;

export interface ConfirmScope {
  // Park a prompt: register it globally and remember it as ours.
  add(id: string, finish: ConfirmFinish): void;
  // Drop a prompt once settled, both globally and from this scope.
  remove(id: string): void;
  // Fail-closed every prompt this scope still owns (disconnect/turn end).
  failAll(): void;
}

export interface ConfirmRegistry {
  // Resolve a parked prompt by id — the POST .../confirm path.
  get(id: string): ConfirmFinish | undefined;
  // A per-stream view that tracks only the prompts it parks.
  scope(): ConfirmScope;
}

export function createConfirmRegistry(): ConfirmRegistry {
  const pending = new Map<string, ConfirmFinish>();
  return {
    get: (id) => pending.get(id),
    scope() {
      const mine = new Set<string>();
      return {
        add(id, finish) {
          pending.set(id, finish);
          mine.add(id);
        },
        remove(id) {
          pending.delete(id);
          mine.delete(id);
        },
        failAll() {
          // Snapshot: each finish() removes itself from `mine` as it settles.
          for (const id of [...mine]) pending.get(id)?.(false);
        },
      };
    },
  };
}
