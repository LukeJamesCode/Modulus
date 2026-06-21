// Routine runner: executes a routine's linear step list. Where the sweep
// fire-and-forgets a single-step schedule, a multi-step routine needs each step
// to finish before the next starts so its output can thread forward — so the
// runner dispatches one agent step, then resumes on that task's completion
// (driven by the agent queue's onTaskUpdate hook).
//
// Deliberately NOT a DAG (that was cut in 0029): steps run top-to-bottom, each
// agent step gets the accumulated output as context, and a step's optional
// `condition` (a case-insensitive substring of the output so far) gates it.
//
// Run state is in-memory: a daemon restart abandons an in-flight run (the
// routine fires again next occurrence). Persisted per-step run history is a
// later phase.

import type { Logger } from '../util/log.js';
import type { RoutineStep } from './agent-schedules.js';

// The completed-task shape the runner needs; a subset of AgentTask so tests can
// drive it without the full engine.
export interface RoutineRunTask {
  id: number;
  status: string;
  result?: string | null;
  error?: string | null;
}

export interface RoutineRunnerDeps {
  // Dispatch one agent step; returns the new task id. Intermediate steps carry
  // no notify target — the runner sends the final result itself.
  dispatch: (agentId: number, prompt: string) => number;
  // Whether an agent still exists (a deleted agent's step is skipped).
  agentExists: (agentId: number) => boolean;
  // Deliver the final result to the user (Telegram). Omitted ⇒ no delivery.
  notify?: (chatId: number, text: string) => void;
  // Record the run outcome on the routine row (for the list's trust line).
  onFinish?: (routineId: number, outcome: { status: 'ok' | 'error'; result: string }) => void;
  log: Logger;
}

export interface StartRunInput {
  routineId: number;
  steps: RoutineStep[];
  notifyChatId: number | null;
}

interface RunState {
  routineId: number;
  steps: RoutineStep[];
  index: number; // next step to consider
  accumulated: string; // threaded output so far
  notifyChatId: number | null;
  errored: boolean;
}

export interface RoutineRunner {
  start(input: StartRunInput): void;
  // Call on every task terminal state; advances the run that owns the task.
  onTaskComplete(task: RoutineRunTask): void;
  activeCount(): number;
}

const MAX_RESULT_CHARS = 4000;

function appendOutput(acc: string, next: string): string {
  const t = (next ?? '').trim();
  if (!t) return acc;
  return acc ? `${acc}\n\n${t}` : t;
}

export function createRoutineRunner(deps: RoutineRunnerDeps): RoutineRunner {
  const log = deps.log.child({ mod: 'routine-runner' });
  // Keyed by the in-flight step's task id.
  const runsByTask = new Map<number, RunState>();

  function matches(accumulated: string, condition: string | undefined): boolean {
    if (!condition || !condition.trim()) return true;
    return accumulated.toLowerCase().includes(condition.trim().toLowerCase());
  }

  function finish(run: RunState): void {
    const status = run.errored ? 'error' : 'ok';
    const result = run.accumulated.trim().slice(0, MAX_RESULT_CHARS);
    deps.onFinish?.(run.routineId, { status, result });
    if (run.notifyChatId != null && result) deps.notify?.(run.notifyChatId, result);
    log.debug('routine run finished', { routineId: run.routineId, status });
  }

  // Walk steps synchronously until an agent step is dispatched (async) or the
  // run completes. Message steps (agentId NULL) and skipped conditional steps
  // advance in-line.
  function advance(run: RunState): void {
    while (run.index < run.steps.length) {
      const step = run.steps[run.index];
      run.index += 1;
      if (!step) continue;
      if (!matches(run.accumulated, step.condition)) continue;
      if (step.agentId == null) {
        run.accumulated = appendOutput(run.accumulated, step.instruction);
        continue;
      }
      if (!deps.agentExists(step.agentId)) {
        log.warn('routine step skipped: agent missing', {
          routineId: run.routineId,
          agentId: step.agentId,
        });
        continue;
      }
      const prompt = run.accumulated
        ? `${step.instruction}\n\nContext from earlier steps:\n${run.accumulated}`
        : step.instruction;
      const taskId = deps.dispatch(step.agentId, prompt);
      runsByTask.set(taskId, run);
      return; // resume in onTaskComplete
    }
    finish(run);
  }

  function start(input: StartRunInput): void {
    if (input.steps.length === 0) return;
    advance({
      routineId: input.routineId,
      steps: input.steps,
      index: 0,
      accumulated: '',
      notifyChatId: input.notifyChatId,
      errored: false,
    });
  }

  function onTaskComplete(task: RoutineRunTask): void {
    if (task.status !== 'done' && task.status !== 'error' && task.status !== 'cancelled') return;
    const run = runsByTask.get(task.id);
    if (!run) return;
    runsByTask.delete(task.id);
    if (task.status === 'done') {
      run.accumulated = appendOutput(run.accumulated, task.result ?? '');
      advance(run);
      return;
    }
    // A failed/cancelled step stops the run; record what we have so far.
    run.errored = true;
    run.accumulated = appendOutput(run.accumulated, task.error ?? `step ${task.status}`);
    finish(run);
  }

  return { start, onTaskComplete, activeCount: () => runsByTask.size };
}
