import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createLogger } from '../util/log.js';
import { createRoutineRunner, type RoutineRunnerDeps } from './routine-runner.js';
import type { RoutineStep } from './agent-schedules.js';

const log = createLogger({ level: 'error', out: () => {}, err: () => {} });

interface Harness {
  dispatched: { agentId: number; prompt: string; taskId: number }[];
  notified: { chatId: number; text: string }[];
  finishes: { routineId: number; status: string; result: string }[];
  runner: ReturnType<typeof createRoutineRunner>;
  // Complete the most recently dispatched task with a result.
  complete: (result: string, status?: string) => void;
}

function harness(opts?: { missingAgents?: number[] }): Harness {
  const dispatched: Harness['dispatched'] = [];
  const notified: Harness['notified'] = [];
  const finishes: Harness['finishes'] = [];
  let nextTaskId = 100;
  const deps: RoutineRunnerDeps = {
    dispatch: (agentId, prompt) => {
      const taskId = nextTaskId++;
      dispatched.push({ agentId, prompt, taskId });
      return taskId;
    },
    agentExists: (id) => !(opts?.missingAgents ?? []).includes(id),
    notify: (chatId, text) => notified.push({ chatId, text }),
    onFinish: (routineId, outcome) => finishes.push({ routineId, ...outcome }),
    log,
  };
  const runner = createRoutineRunner(deps);
  return {
    dispatched,
    notified,
    finishes,
    runner,
    complete: (result, status = 'done') => {
      const last = dispatched[dispatched.length - 1];
      assert.ok(last, 'a task must be in flight to complete');
      runner.onTaskComplete({ id: last.taskId, status, result });
    },
  };
}

test('routine-runner: threads each step output into the next and notifies the final result', () => {
  const h = harness();
  const steps: RoutineStep[] = [
    { agentId: 1, instruction: 'get the agenda' },
    { agentId: 2, instruction: 'summarize the news' },
  ];
  h.runner.start({ routineId: 7, steps, notifyChatId: 555 });

  // Step 1 dispatched with no prior context.
  assert.equal(h.dispatched.length, 1);
  assert.equal(h.dispatched[0]!.agentId, 1);
  assert.ok(!h.dispatched[0]!.prompt.includes('Context'));
  h.complete('AGENDA');

  // Step 2 dispatched with step 1's output threaded in.
  assert.equal(h.dispatched.length, 2);
  assert.equal(h.dispatched[1]!.agentId, 2);
  assert.ok(h.dispatched[1]!.prompt.includes('AGENDA'));
  h.complete('NEWS');

  assert.equal(h.finishes.length, 1);
  assert.equal(h.finishes[0]!.status, 'ok');
  assert.ok(h.finishes[0]!.result.includes('AGENDA') && h.finishes[0]!.result.includes('NEWS'));
  assert.equal(h.notified.length, 1);
  assert.equal(h.notified[0]!.chatId, 555);
});

test('routine-runner: a step condition gates on the accumulated output', () => {
  const h = harness();
  const steps: RoutineStep[] = [
    { agentId: 1, instruction: 'check weather' },
    { agentId: 2, instruction: 'pack umbrella', condition: 'rain' },
    { agentId: 3, instruction: 'final note' },
  ];
  h.runner.start({ routineId: 1, steps, notifyChatId: null });
  h.complete('clear skies, no rain at all'); // contains "rain" → condition matches
  // condition "rain" is a substring of "no rain" so step 2 runs
  assert.equal(h.dispatched[1]!.agentId, 2);
  h.complete('packed');
  assert.equal(h.dispatched[2]!.agentId, 3);
  h.complete('done');
  assert.equal(h.finishes[0]!.status, 'ok');
});

test('routine-runner: skips a conditional step whose keyword is absent', () => {
  const h = harness();
  const steps: RoutineStep[] = [
    { agentId: 1, instruction: 'check weather' },
    { agentId: 2, instruction: 'pack umbrella', condition: 'rain' },
  ];
  h.runner.start({ routineId: 1, steps, notifyChatId: null });
  h.complete('bright and sunny'); // no "rain" → step 2 skipped → run finishes
  assert.equal(h.dispatched.length, 1, 'step 2 was skipped');
  assert.equal(h.finishes.length, 1);
});

test('routine-runner: a message step appends without dispatching', () => {
  const h = harness();
  const steps: RoutineStep[] = [
    { agentId: 1, instruction: 'do the work' },
    { agentId: null, instruction: 'All done for today.' },
  ];
  h.runner.start({ routineId: 1, steps, notifyChatId: 9 });
  h.complete('WORK RESULT');
  assert.equal(h.dispatched.length, 1, 'the message step does not dispatch a task');
  assert.equal(h.finishes.length, 1);
  assert.ok(h.notified[0]!.text.includes('All done for today.'));
});

test('routine-runner: a missing agent step is skipped, not fatal', () => {
  const h = harness({ missingAgents: [2] });
  const steps: RoutineStep[] = [
    { agentId: 1, instruction: 'a' },
    { agentId: 2, instruction: 'b (agent deleted)' },
    { agentId: 3, instruction: 'c' },
  ];
  h.runner.start({ routineId: 1, steps, notifyChatId: null });
  h.complete('A');
  // Step 2's agent is missing → skipped → step 3 dispatched next.
  assert.equal(h.dispatched[1]!.agentId, 3);
  h.complete('C');
  assert.equal(h.finishes[0]!.status, 'ok');
});

test('routine-runner: a failed step stops the run and records an error', () => {
  const h = harness();
  const steps: RoutineStep[] = [
    { agentId: 1, instruction: 'a' },
    { agentId: 2, instruction: 'b' },
  ];
  h.runner.start({ routineId: 1, steps, notifyChatId: null });
  h.runner.onTaskComplete({ id: h.dispatched[0]!.taskId, status: 'error', error: 'boom' });
  assert.equal(h.dispatched.length, 1, 'no further steps after a failure');
  assert.equal(h.finishes.length, 1);
  assert.equal(h.finishes[0]!.status, 'error');
});
