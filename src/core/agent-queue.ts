// Resource-aware background queue for agent tasks.
//
// The governor is keyed to the MODEL, not a thread count, because that is the
// real constraint on a small machine: Ollama keeps exactly one heavy (7-9B)
// model resident at a time (see llm.ts "Heavy-model eviction"). So:
//
//   - at most `heavyConcurrency` (default 1) tasks on a heavy profile run at
//     once — two reasoning agents can never thrash the model cache against
//     each other on a Pi;
//   - tasks on a tiny (0.5-0.8B) profile may run up to `tinyConcurrency`, a
//     tier-scaled cap (Small 1, Standard 2, Heavy 3-4);
//   - an agent whose execution_mode is `sequential` runs at most one of its
//     own tasks at a time; `parallel` lets it run up to its max_concurrency,
//     still inside the global model budget above.
//
// The loop is event-driven: notify() (on enqueue or task completion) triggers
// a synchronous scan that starts as many runnable tasks as capacity allows.
// No polling timer — a task that can't start now starts the moment a slot
// frees up.

import type { Logger } from '../util/log.js';
import type { LLM, ProfileName } from './llm.js';
import {
  AGENT_TASK_CANCELLED_MESSAGE,
  type AgentRegistry,
  type AgentRuntime,
  type AgentTask,
  type EnqueueTaskInput,
} from './agents.js';

export interface AgentQueueOptions {
  registry: AgentRegistry;
  runtime: AgentRuntime;
  // Used only to read whether an agent's profile occupies the heavy slot.
  llm: LLM;
  log: Logger;
  // Max concurrent tasks on a tiny (non-heavy) profile. Tier-scaled by the
  // caller. Defaults to 1 (Pi-safe).
  tinyConcurrency?: number;
  // Max concurrent tasks on a heavy profile. Physically 1 on Ollama; exposed
  // only so tests can be explicit. Do not raise above 1 in production.
  heavyConcurrency?: number;
  // Fired whenever a task changes state (started/finished). Wired to SSE /
  // checkpoint nudges by the surfaces; optional.
  onTaskUpdate?: (task: AgentTask) => void;
  // Re-scan the DB on this interval (ms). The web panel runs in a SEPARATE
  // process and enqueues tasks by inserting rows; the daemon — the single
  // owner of task execution — can't be notified in-process, so it polls. 0 or
  // unset disables polling (tests drive tick() via notify()).
  pollMs?: number;
}

export interface AgentQueue {
  // Enqueue a task and kick the scheduler.
  dispatch(input: EnqueueTaskInput): AgentTask;
  // Re-scan for runnable work. Call after enqueuing through the registry
  // directly (e.g. the spawn_agent tool).
  notify(): void;
  // Cancel queued work or abort a running task owned by this process.
  cancel(taskId: number): boolean;
  // Pause a queued or running task. `until` is an epoch ms timestamp for
  // timed pauses, or null for an indefinite pause.
  pause(taskId: number, until: number | null): boolean;
  // Resume a paused task by re-queuing it.
  resume(taskId: number): boolean;
  // True while a task is in flight or queued work remains.
  busy(): boolean;
  runningCount(): number;
  // Stop scheduling new work and wait for in-flight tasks to finish.
  drain(): Promise<void>;
}

interface RunningEntry {
  heavy: boolean;
  agentId: number;
  promise: Promise<unknown>;
}

export function createAgentQueue(opts: AgentQueueOptions): AgentQueue {
  const log = opts.log.child({ mod: 'agent-queue' });
  const tinyConcurrency = Math.max(1, opts.tinyConcurrency ?? 1);
  const heavyConcurrency = Math.max(1, opts.heavyConcurrency ?? 1);
  const running = new Map<number, RunningEntry>();
  let draining = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  function isHeavyProfile(profile: ProfileName): boolean {
    return opts.llm.listProfiles()[profile]?.heavy === true;
  }

  function runningHeavy(): number {
    let n = 0;
    for (const e of running.values()) if (e.heavy) n++;
    return n;
  }

  function runningTiny(): number {
    let n = 0;
    for (const e of running.values()) if (!e.heavy) n++;
    return n;
  }

  function runningForAgent(agentId: number): number {
    let n = 0;
    for (const e of running.values()) if (e.agentId === agentId) n++;
    return n;
  }

  // Can `task` start right now? Reads live in-memory counts; the agent
  // definition supplies the profile (heaviness) and the per-agent policy.
  function canStart(task: AgentTask): boolean {
    const agent = opts.registry.get(task.agentId);
    if (!agent) return false;
    const heavy = isHeavyProfile(agent.profile);
    if (heavy) {
      if (runningHeavy() >= heavyConcurrency) return false;
    } else if (runningTiny() >= tinyConcurrency) {
      return false;
    }
    const perAgentCap =
      agent.executionMode === 'sequential' ? 1 : Math.max(1, agent.maxConcurrency);
    if (runningForAgent(task.agentId) >= perAgentCap) return false;
    return true;
  }

  function start(task: AgentTask): void {
    const agent = opts.registry.get(task.agentId);
    if (!agent) return;
    const heavy = isHeavyProfile(agent.profile);
    log.debug('starting agent task', { taskId: task.id, agent: agent.name, heavy });
    // runTask marks the row running synchronously before its first await, so a
    // subsequent scan in this same tick won't re-select it; the in-memory
    // entry guards against re-entrant ticks regardless.
    const promise = opts.runtime
      .runTask(task.id)
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        log.error('agent task failed to run', { taskId: task.id, error: msg });
        // Best-effort terminal state so the task doesn't dangle as 'running'.
        opts.registry.updateTask(task.id, {
          status: 'error',
          error: msg,
          finishedAt: Date.now(),
        });
      })
      .finally(() => {
        running.delete(task.id);
        const finished = opts.registry.getTask(task.id);
        if (finished) opts.onTaskUpdate?.(finished);
        // A heavy task just finished (done/error/cancelled) and the queue has
        // drained — unload the resident heavy model now instead of letting it
        // pin RAM through the keep_alive / idle-sweep window. Gated on `heavy`
        // so a finishing tiny task never evicts a heavy model that interactive
        // chat may be holding; gated on idle so back-to-back tasks reuse it.
        if (
          heavy &&
          running.size === 0 &&
          opts.registry.listTasks({ status: 'queued' }).length === 0
        ) {
          void opts.llm.releaseHeavy?.();
        }
        // A freed slot may unblock other queued work.
        notify();
      });
    running.set(task.id, { heavy, agentId: task.agentId, promise });
    const started = opts.registry.getTask(task.id);
    if (started) opts.onTaskUpdate?.(started);
  }

  // Synchronous scan. Walk queued tasks in priority order and start every one
  // capacity allows. A blocked candidate doesn't stop the scan — a tiny task
  // can still start while the heavy slot is full.
  function cancelRequestedRunningTasks(): void {
    for (const [taskId] of running) {
      const task = opts.registry.getTask(taskId);
      if (task?.status === 'cancelled' || task?.status === 'paused') {
        opts.runtime.cancelTask(taskId);
      }
    }
  }

  function sweepPausedTasks(): void {
    const paused = opts.registry.listTasks({ status: 'paused' });
    const now = Date.now();
    for (const task of paused) {
      if (task.pausedUntil !== null && task.pausedUntil <= now) {
        opts.registry.updateTask(task.id, { status: 'queued', pausedUntil: null });
        log.debug('auto-resumed paused task', { taskId: task.id });
      }
    }
  }

  function tick(): void {
    if (draining) return;
    cancelRequestedRunningTasks();
    sweepPausedTasks();
    const queued = opts.registry.listTasks({ status: 'queued' });
    // listTasks returns newest-first; run oldest-first within a priority band.
    queued.sort((a, b) => b.priority - a.priority || a.id - b.id);
    for (const task of queued) {
      if (running.has(task.id)) continue;
      if (canStart(task)) start(task);
    }
  }

  function notify(): void {
    // Defer to a microtask so a burst of synchronous enqueues coalesces into a
    // single scan, and so start()'s synchronous status writes settle first.
    queueMicrotask(tick);
  }

  function dispatch(input: EnqueueTaskInput): AgentTask {
    const task = opts.registry.enqueue(input);
    notify();
    return task;
  }

  function cancel(taskId: number): boolean {
    const task = opts.registry.getTask(taskId);
    if (!task) return false;
    if (task.status === 'done' || task.status === 'error' || task.status === 'cancelled') {
      return false;
    }
    opts.registry.updateTask(taskId, {
      status: 'cancelled',
      error: AGENT_TASK_CANCELLED_MESSAGE,
      finishedAt: Date.now(),
    });
    if (running.has(taskId)) opts.runtime.cancelTask(taskId);
    const cancelled = opts.registry.getTask(taskId);
    if (cancelled) opts.onTaskUpdate?.(cancelled);
    notify();
    return true;
  }

  function pause(taskId: number, until: number | null): boolean {
    const task = opts.registry.getTask(taskId);
    if (!task) return false;
    if (task.status !== 'queued' && task.status !== 'running') return false;
    opts.registry.updateTask(taskId, {
      status: 'paused',
      pausedUntil: until,
    });
    if (running.has(taskId)) opts.runtime.cancelTask(taskId);
    const paused = opts.registry.getTask(taskId);
    if (paused) opts.onTaskUpdate?.(paused);
    notify();
    return true;
  }

  function resume(taskId: number): boolean {
    const task = opts.registry.getTask(taskId);
    if (!task) return false;
    if (task.status !== 'paused') return false;
    opts.registry.updateTask(taskId, {
      status: 'queued',
      pausedUntil: null,
    });
    const resumed = opts.registry.getTask(taskId);
    if (resumed) opts.onTaskUpdate?.(resumed);
    notify();
    return true;
  }

  async function drain(): Promise<void> {
    draining = true;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    while (running.size > 0) {
      await Promise.all([...running.values()].map((e) => e.promise));
    }
  }

  if (opts.pollMs && opts.pollMs > 0) {
    pollTimer = setInterval(tick, opts.pollMs);
    // Don't keep the event loop alive just for the poll.
    pollTimer.unref?.();
  }

  return {
    dispatch,
    notify,
    cancel,
    pause,
    resume,
    busy: () => running.size > 0 || opts.registry.listTasks({ status: 'queued' }).length > 0,
    runningCount: () => running.size,
    drain,
  };
}
