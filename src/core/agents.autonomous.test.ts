// Autonomous-loop behaviour: the plan->act->reflect loop must (1) drive its own
// planning tools to completion and stop on `finish`, (2) resume from a checkpoint
// rather than replaying the goal, and (3) stop when a budget trips instead of
// looping forever. These encode WHY the loop exists — long-horizon runs that end
// deterministically — not just that a single turn returns text.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../storage/db.js';
import { createLogger } from '../util/log.js';
import { createToolRegistry } from './tools.js';
import type { LLM, ChatChunk, ChatOptions } from './llm.js';
import { createAgentRegistry, createAgentRuntime, type AgentRegistry } from './agents.js';
import { setupAgentPlanning } from './agent-planning.js';

function silentLogger() {
  return createLogger({ level: 'error', out: () => {}, err: () => {} });
}
function tmp() {
  return mkdtempSync(join(tmpdir(), 'modulus-autonomous-'));
}

function fakeLlm(scripts: Array<() => AsyncIterable<ChatChunk>>): LLM & { calls: ChatOptions[] } {
  const calls: ChatOptions[] = [];
  let i = 0;
  const llm: LLM = {
    chat(opts) {
      calls.push(opts);
      const next = scripts[i++];
      if (!next) throw new Error(`llm script exhausted at call ${i}`);
      return next();
    },
    async health() {
      return { ok: true, models: ['fake'] };
    },
    listProfiles() {
      return {
        chat: { model: 'fake', contextTokens: 4096, heavy: false },
        reason: { model: 'fake-reason', contextTokens: 8192, heavy: true },
        tools: { model: 'fake-tools', contextTokens: 4096, heavy: false },
      };
    },
    resolveModel: () => 'fake',
    breakerSnapshot: () => ({
      state: 'closed',
      failures: 0,
      consecutiveSuccesses: 0,
      openedAt: null,
      retryAt: null,
    }),
    stopIdleEviction: () => {},
  };
  return Object.assign(llm, { calls });
}

function textStream(text: string): () => AsyncIterable<ChatChunk> {
  return async function* () {
    yield { delta: text, done: true, model: 'fake', promptTokens: 5, completionTokens: 1 };
  };
}
function toolCall(name: string, args: Record<string, unknown>): () => AsyncIterable<ChatChunk> {
  return async function* () {
    yield { delta: '', done: false, toolCalls: [{ id: `t_${name}`, name, arguments: args }] };
    yield { delta: '', done: true, model: 'fake', promptTokens: 5, completionTokens: 1 };
  };
}

function harness(scripts: Array<() => AsyncIterable<ChatChunk>>) {
  const dir = tmp();
  const db = open({ path: join(dir, 'g.db') });
  const llm = fakeLlm(scripts);
  const tools = createToolRegistry({ log: silentLogger() });
  const registry = createAgentRegistry(db);
  setupAgentPlanning({ tools, registry, log: silentLogger() });
  const runtime = createAgentRuntime({
    db,
    llm,
    tools,
    log: silentLogger(),
    registry,
    ownerUserId: 1,
  });
  return {
    dir,
    db,
    llm,
    registry,
    runtime,
    cleanup: async () => {
      await runtime.shutdown();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function makeAutonomous(registry: AgentRegistry, over: Record<string, unknown> = {}) {
  return registry.create({
    name: 'op',
    systemPrompt: 'You are autonomous.',
    profile: 'chat',
    mode: 'autonomous',
    toolAllowlist: [],
    maxToolRounds: 4,
    ...over,
  });
}

test('autonomous: plans, works, and stops on finish', async () => {
  // Turn 1: author a plan (non-self-replying tool -> a follow-up text turn ends it).
  // Turn 2: call finish (self-replying) -> its summary becomes the result.
  const h = harness([
    toolCall('update_plan', { steps: [{ title: 'gather' }, { title: 'write' }] }),
    textStream('Planned the work.'),
    toolCall('finish', { summary: 'All done — here is the result.' }),
  ]);
  try {
    const agent = makeAutonomous(h.registry);
    const task = h.registry.enqueue({ agentId: agent.id, prompt: 'Do the whole thing' });

    const res = await h.runtime.runTask(task.id);

    assert.equal(res.ok, true);
    assert.equal(res.text, 'All done — here is the result.');
    const after = h.registry.getTask(task.id)!;
    assert.equal(after.status, 'done');
    assert.equal(after.result, 'All done — here is the result.');
    // finish marks the whole plan done so the UI reads 100%.
    assert.ok(after.plan && after.plan.steps.every((s) => s.status === 'done'));
    // Two loop turns ran (plan, then finish).
    assert.equal(after.roundsUsed, 2);
    // The first turn used the ORIGINAL goal, not a continuation prompt.
    assert.match(JSON.stringify(h.llm.calls[0]!.messages), /Do the whole thing/);
  } finally {
    h.cleanup();
  }
});

test('autonomous: resumes from a checkpoint instead of replaying the goal', async () => {
  // Only one scripted turn: if the loop wrongly restarted from scratch it would
  // try to plan first and exhaust the script. Resuming means it goes straight to
  // a continuation turn and finishes.
  const h = harness([toolCall('finish', { summary: 'Resumed and finished.' })]);
  try {
    const agent = makeAutonomous(h.registry);
    const task = h.registry.enqueue({ agentId: agent.id, prompt: 'Long goal' });
    // Simulate a checkpoint left by a previous (interrupted) run: one step done,
    // one pending, a round already spent, re-queued after a restart.
    h.registry.updateTask(task.id, {
      plan: {
        steps: [
          { id: 's1', title: 'first', status: 'done' },
          { id: 's2', title: 'second', status: 'pending' },
        ],
      },
      roundsUsed: 1,
      stepCursor: 1,
    });

    const res = await h.runtime.runTask(task.id);

    assert.equal(res.ok, true);
    assert.equal(res.text, 'Resumed and finished.');
    // The very first model call on resume is a CONTINUATION turn, not planning.
    assert.match(JSON.stringify(h.llm.calls[0]!.messages), /Continue working the task/);
    // It continued counting rounds from the checkpoint (1 -> 2).
    assert.equal(h.registry.getTask(task.id)!.roundsUsed, 2);
  } finally {
    h.cleanup();
  }
});

test('autonomous: re-wording the plan without completing a step trips the stall guard', async () => {
  // Regression: a model that re-authors its plan every turn (different step
  // titles) but never calls complete_step or finish used to reset the stall
  // counter each turn — because the old guard compared the plan JSON string —
  // and so ran all the way to the round/wall-clock budget. The guard now keys
  // on completed-step count, so this must stop after AUTONOMOUS_STALL_LIMIT (5)
  // no-progress turns, well short of the default 30-round budget.
  const scripts: Array<() => AsyncIterable<ChatChunk>> = [];
  // Turn 0 authors a plan (counts as progress: done-count -1 -> 0); turns 1..5
  // re-word it with no completion (stall 1..5). Each non-self-replying tool turn
  // consumes a tool call + a follow-up text turn.
  for (let i = 0; i < 6; i++) {
    scripts.push(toolCall('update_plan', { steps: [{ title: `analyse the repo, take ${i}` }] }));
    scripts.push(textStream(`re-planned (${i})`));
  }
  // Finalize turn (outside the work loop): the model wraps up.
  scripts.push(toolCall('finish', { summary: 'Could not make progress; stopping.' }));
  const h = harness(scripts);
  try {
    const agent = makeAutonomous(h.registry); // default 30-round budget
    const task = h.registry.enqueue({ agentId: agent.id, prompt: 'Review the repo' });

    const res = await h.runtime.runTask(task.id);

    assert.equal(res.ok, true);
    assert.equal(res.text, 'Could not make progress; stopping.');
    // Stopped at the stall limit (6 work turns: 1 progress + 5 stalled), not the
    // 30-round budget.
    assert.equal(h.registry.getTask(task.id)!.roundsUsed, 6);
    assert.equal(h.registry.getTask(task.id)!.status, 'done');
  } finally {
    h.cleanup();
  }
});

test('autonomous: a round budget stops the loop and finalises', async () => {
  // maxTotalRounds=1: exactly one work turn is allowed; the loop must then
  // finalise (one extra finish turn) rather than keep working forever.
  const h = harness([
    toolCall('update_plan', { steps: [{ title: 'a' }, { title: 'b' }] }),
    textStream('Planned but not finished.'),
    // Finalize turn (outside the work loop) — model wraps up with finish.
    toolCall('finish', { summary: 'Wrapped up at the budget.' }),
  ]);
  try {
    const agent = makeAutonomous(h.registry, { maxTotalRounds: 1 });
    const task = h.registry.enqueue({ agentId: agent.id, prompt: 'Endless goal' });

    const res = await h.runtime.runTask(task.id);

    assert.equal(res.ok, true);
    assert.equal(res.text, 'Wrapped up at the budget.');
    // Only ONE work turn ran despite the plan being incomplete after it.
    assert.equal(h.registry.getTask(task.id)!.roundsUsed, 1);
    assert.equal(h.registry.getTask(task.id)!.status, 'done');
  } finally {
    h.cleanup();
  }
});
