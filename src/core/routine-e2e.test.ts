// End-to-end routine engine test. Wires the real pieces the daemon wires
// (scheduler → agent-schedules sweep → routine-runner → agent-queue → runtime →
// completion → notify/recordRun) with a fake model, and drives a few "custom
// test routines" through them — the same paths the panel exercises, minus
// Ollama. Proves the news-style single-agent path delivers a *result* (the bug
// the user hit was a routine with no agent, which silently echoed the prompt),
// that multi-step routines thread output across steps, and documents the
// no-agent contrast.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../storage/db.js';
import { createLogger } from '../util/log.js';
import { createToolRegistry } from './tools.js';
import type { LLM, ChatChunk } from './llm.js';
import { createAgentRegistry, createAgentRuntime } from './agents.js';
import { createAgentQueue } from './agent-queue.js';
import { createScheduler, type Nudge } from './scheduler.js';
import { setupAgentSchedules } from './agent-schedules.js';
import { createRoutineRunner, type RoutineRunner } from './routine-runner.js';
import { formatTaskNotification } from '../adapters/agent-commands.js';

function silentLogger() {
  return createLogger({ level: 'error', out: () => {}, err: () => {} });
}

// A fake model that completes immediately. Each call records the last user
// message it saw (so we can prove step N+1's prompt carried step N's output)
// and returns a distinct `OUT<n>` token (so we can prove that output was
// actually delivered to the user).
function fakeLlm() {
  let counter = 0;
  const seenUserPrompts: string[] = [];
  const llm: LLM = {
    chat(o) {
      const lastUser = [...o.messages].reverse().find((m) => m.role === 'user');
      seenUserPrompts.push(typeof lastUser?.content === 'string' ? lastUser.content : '');
      const n = ++counter;
      return (async function* (): AsyncIterable<ChatChunk> {
        yield { delta: `OUT${n}`, done: true, model: 'fake', promptTokens: 1, completionTokens: 1 };
      })();
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
    async releaseHeavy() {},
  };
  return { llm, seenUserPrompts };
}

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'modulus-routine-e2e-'));
  const db = open({ path: join(dir, 'g.db') });
  const reg = createAgentRegistry(db);
  const tools = createToolRegistry({ log: silentLogger() });
  const { llm, seenUserPrompts } = fakeLlm();
  const runtime = createAgentRuntime({
    db,
    llm,
    tools,
    log: silentLogger(),
    registry: reg,
    ownerUserId: 1,
  });

  // Captures of everything the user would actually receive.
  const notifies: { chatId: number; text: string }[] = [];
  const nudges: Nudge[] = [];
  const routineRef: { runner?: RoutineRunner } = {};

  const queue = createAgentQueue({
    registry: reg,
    runtime,
    llm,
    log: silentLogger(),
    onTaskUpdate: (task) => {
      routineRef.runner?.onTaskComplete(task);
      if (task.notifyChatId == null) return;
      const agent = reg.get(task.agentId);
      const text = formatTaskNotification(task, agent?.name ?? 'agent');
      if (text) notifies.push({ chatId: task.notifyChatId, text });
    },
  });

  const scheduler = createScheduler({
    log: silentLogger(),
    dispatch: (n) => {
      nudges.push(n);
    },
  });
  const store = setupAgentSchedules({
    db,
    scheduler,
    registry: reg,
    queue,
    log: silentLogger(),
    onFired: (fired) => {
      for (const s of fired) {
        if (s.steps && s.steps.length > 0) {
          routineRef.runner!.start({ routineId: s.id, steps: s.steps, notifyChatId: s.notifyChatId });
        }
      }
    },
  });
  routineRef.runner = createRoutineRunner({
    dispatch: (agentId, prompt) => queue.dispatch({ agentId, prompt }).id,
    agentExists: (id) => !!reg.get(id),
    notify: (chatId, text) => notifies.push({ chatId, text }),
    onFinish: (id, outcome) => store.recordRun(id, outcome),
    log: silentLogger(),
  });

  async function waitFor(cond: () => boolean, ms = 4000) {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > ms) throw new Error('timeout waiting for condition');
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  return {
    db,
    reg,
    store,
    scheduler,
    notifies,
    nudges,
    seenUserPrompts,
    waitFor,
    cleanup: async () => {
      await queue.drain();
      await runtime.shutdown();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('e2e: a news-style single-agent routine runs the agent and delivers its result', async () => {
  const h = harness();
  try {
    const news = h.reg.create({ name: 'news', systemPrompt: 'you fetch news', toolAllowlist: [] });
    // One agent step → the store collapses it to a legacy agent schedule.
    const routine = h.store.create({
      agentIds: [],
      steps: [{ agentId: news.id, instruction: 'Find the top news and summarize it.' }],
      // Safely in the past: tickAt() zeroes the seconds, so firedAt can trail
      // wall-clock by up to a minute — a -1ms due time wouldn't be selected.
      nextRunAt: Date.now() - 5 * 60_000,
      recurrence: 'once',
      notifyChatId: 4242,
    });
    assert.equal(routine.steps, null, 'single step collapses to the legacy agent path');
    assert.deepEqual(routine.agentIds, [news.id], 'the agent is attached');

    await h.scheduler.tickAt(new Date());
    await h.waitFor(() => h.notifies.length > 0);

    // The user receives the agent's OUTPUT, not the prompt echoed back.
    assert.equal(h.notifies.length, 1);
    assert.match(h.notifies[0]!.text, /OUT1/, 'delivers the agent result');
    assert.doesNotMatch(h.notifies[0]!.text, /Find the top news/, 'not a bare prompt echo');
    assert.equal(h.reg.listTasks({ status: 'done' }).length, 1);
  } finally {
    await h.cleanup();
  }
});

test('e2e: a multi-step routine threads each step output into the next', async () => {
  const h = harness();
  try {
    const a1 = h.reg.create({ name: 'agenda', systemPrompt: 'agenda', toolAllowlist: [] });
    const a2 = h.reg.create({ name: 'news', systemPrompt: 'news', toolAllowlist: [] });
    const routine = h.store.create({
      agentIds: [],
      steps: [
        { agentId: a1.id, instruction: "Pull today's agenda." },
        { agentId: a2.id, instruction: 'Summarize the news.' },
      ],
      // Safely in the past: tickAt() zeroes the seconds, so firedAt can trail
      // wall-clock by up to a minute — a -1ms due time wouldn't be selected.
      nextRunAt: Date.now() - 5 * 60_000,
      recurrence: 'once',
      notifyChatId: 99,
    });
    assert.equal(routine.steps?.length, 2, 'stored as a multi-step routine');

    await h.scheduler.tickAt(new Date());
    await h.waitFor(() => h.store.get(routine.id)?.lastStatus != null);

    // Two agent calls ran, in order; step 2's prompt carried step 1's output.
    assert.equal(h.seenUserPrompts.length, 2);
    assert.match(h.seenUserPrompts[1]!, /OUT1/, "step 2's prompt contains step 1's output");

    // The final delivery combines both step outputs, and the outcome is recorded.
    assert.equal(h.notifies.length, 1, 'one final message, not one per step');
    assert.match(h.notifies[0]!.text, /OUT1/);
    assert.match(h.notifies[0]!.text, /OUT2/);
    assert.equal(h.store.get(routine.id)?.lastStatus, 'ok');
    assert.match(h.store.get(routine.id)?.lastResult ?? '', /OUT1[\s\S]*OUT2/);
  } finally {
    await h.cleanup();
  }
});

test('e2e: a routine with no agent only echoes the prompt (the original bug)', async () => {
  const h = harness();
  try {
    // No agents, just a notify target — what the broken default produced.
    h.store.create({
      agentIds: [],
      prompt: 'Find the top news and summarize it.',
      // Safely in the past: tickAt() zeroes the seconds, so firedAt can trail
      // wall-clock by up to a minute — a -1ms due time wouldn't be selected.
      nextRunAt: Date.now() - 5 * 60_000,
      recurrence: 'once',
      notifyChatId: 7,
    });

    await h.scheduler.tickAt(new Date());

    // No agent ran; the user just gets their own words back as a nudge.
    assert.equal(h.notifies.length, 0, 'no agent task, so no result notification');
    assert.equal(h.nudges.length, 1);
    assert.equal(h.nudges[0]!.text, 'Find the top news and summarize it.');
    assert.equal(h.reg.listTasks().length, 0, 'nothing was dispatched');
  } finally {
    await h.cleanup();
  }
});
