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

function silentLogger() {
  return createLogger({ level: 'error', out: () => {}, err: () => {} });
}
function tmp() {
  return mkdtempSync(join(tmpdir(), 'modulus-queue-'));
}
const settle = () => new Promise((r) => setTimeout(r, 20));

// A FakeLLM whose every chat() call parks until released, so a test can hold
// model calls in flight and observe how many run concurrently. Tracks the peak
// concurrency per slot class (heavy = 'reason' profile, tiny = everything else).
function gatedLlm() {
  const waiters: Array<() => void> = [];
  let activeHeavy = 0;
  let activeTiny = 0;
  let releaseHeavyCalls = 0;
  const peak = { heavy: 0, tiny: 0 };
  const llm: LLM = {
    chat(o) {
      const heavy = o.profile === 'reason';
      return (async function* (): AsyncIterable<ChatChunk> {
        if (heavy) peak.heavy = Math.max(peak.heavy, ++activeHeavy);
        else peak.tiny = Math.max(peak.tiny, ++activeTiny);
        await new Promise<void>((res) => waiters.push(res));
        if (heavy) activeHeavy--;
        else activeTiny--;
        yield { delta: 'done', done: true, model: 'fake', promptTokens: 1, completionTokens: 1 };
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
    async releaseHeavy() {
      releaseHeavyCalls++;
    },
  };
  return {
    llm,
    releaseAll: () => {
      while (waiters.length) waiters.shift()!();
    },
    inFlight: () => waiters.length,
    releaseHeavyCalls: () => releaseHeavyCalls,
    peak,
  };
}

function harness(tinyConcurrency: number) {
  const dir = tmp();
  const db = open({ path: join(dir, 'g.db') });
  const reg = createAgentRegistry(db);
  const gate = gatedLlm();
  const tools = createToolRegistry({ log: silentLogger() });
  const runtime = createAgentRuntime({
    db,
    llm: gate.llm,
    tools,
    log: silentLogger(),
    registry: reg,
    ownerUserId: 1,
  });
  const queue = createAgentQueue({
    registry: reg,
    runtime,
    llm: gate.llm,
    log: silentLogger(),
    tinyConcurrency,
  });
  const cleanup = async () => {
    gate.releaseAll();
    await queue.drain();
    await runtime.shutdown();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { db, reg, gate, queue, cleanup };
}

test('queue: two heavy tasks never run concurrently (one resident model)', async () => {
  const h = harness(4);
  try {
    // Two different reasoning agents, both heavy. Even with tinyConcurrency=4,
    // the heavy slot is physically 1.
    const a = h.reg.create({ name: 'r1', systemPrompt: 'x', profile: 'reason', toolAllowlist: [] });
    const b = h.reg.create({ name: 'r2', systemPrompt: 'x', profile: 'reason', toolAllowlist: [] });
    h.queue.dispatch({ agentId: a.id, prompt: 'go' });
    h.queue.dispatch({ agentId: b.id, prompt: 'go' });
    await settle();

    // Exactly one heavy model call is in flight; the second task waits.
    assert.equal(h.gate.inFlight(), 1);
    assert.equal(h.gate.peak.heavy, 1);

    h.gate.releaseAll(); // first finishes -> second starts
    await settle();
    h.gate.releaseAll(); // second finishes
    await settle();

    assert.equal(h.gate.peak.heavy, 1);
    assert.equal(h.reg.listTasks({ status: 'done' }).length, 2);
  } finally {
    await h.cleanup();
  }
});

test('queue: a finished heavy task drains -> unloads the resident heavy model', async () => {
  // WHY: a one-shot reasoning agent should not pin the 9b in RAM for the whole
  // keep_alive window once the queue has no more work. The queue asks the LLM to
  // release the heavy slot the instant it goes idle after a heavy task.
  const h = harness(4);
  try {
    const a = h.reg.create({ name: 'r1', systemPrompt: 'x', profile: 'reason', toolAllowlist: [] });
    h.queue.dispatch({ agentId: a.id, prompt: 'go' });
    await settle();
    assert.equal(h.gate.releaseHeavyCalls(), 0, 'no release while the task is still running');
    h.gate.releaseAll();
    await settle();
    assert.equal(h.reg.listTasks({ status: 'done' }).length, 1);
    assert.equal(h.gate.releaseHeavyCalls(), 1, 'heavy model released once the queue drained');
  } finally {
    await h.cleanup();
  }
});

test('queue: a finished tiny task never releases the heavy slot', async () => {
  // A tiny agent shares the interactive chat model — releasing it would force a
  // cold reload on the next Telegram turn. Only heavy completions trigger a
  // release.
  const h = harness(4);
  try {
    const a = h.reg.create({ name: 't1', systemPrompt: 'x', profile: 'chat', toolAllowlist: [] });
    h.queue.dispatch({ agentId: a.id, prompt: 'go' });
    await settle();
    h.gate.releaseAll();
    await settle();
    assert.equal(h.reg.listTasks({ status: 'done' }).length, 1);
    assert.equal(h.gate.releaseHeavyCalls(), 0, 'tiny completion must not touch the heavy slot');
  } finally {
    await h.cleanup();
  }
});

test('queue: tiny tasks run in parallel up to the tier cap', async () => {
  const h = harness(2);
  try {
    const a = h.reg.create({ name: 't1', systemPrompt: 'x', profile: 'chat', toolAllowlist: [] });
    const b = h.reg.create({ name: 't2', systemPrompt: 'x', profile: 'chat', toolAllowlist: [] });
    const c = h.reg.create({ name: 't3', systemPrompt: 'x', profile: 'chat', toolAllowlist: [] });
    h.queue.dispatch({ agentId: a.id, prompt: 'go' });
    h.queue.dispatch({ agentId: b.id, prompt: 'go' });
    h.queue.dispatch({ agentId: c.id, prompt: 'go' });
    await settle();

    // Cap is 2: two run, the third waits.
    assert.equal(h.gate.inFlight(), 2);
    assert.equal(h.gate.peak.tiny, 2);

    h.gate.releaseAll();
    await settle();
    h.gate.releaseAll();
    await settle();
    assert.equal(h.reg.listTasks({ status: 'done' }).length, 3);
    // Never exceeded the cap across the whole run.
    assert.equal(h.gate.peak.tiny, 2);
  } finally {
    await h.cleanup();
  }
});

test('queue: a sequential agent runs its own tasks one at a time', async () => {
  const h = harness(4);
  try {
    const a = h.reg.create({
      name: 'seq',
      systemPrompt: 'x',
      profile: 'chat',
      executionMode: 'sequential',
      toolAllowlist: [],
    });
    h.queue.dispatch({ agentId: a.id, prompt: 'one' });
    h.queue.dispatch({ agentId: a.id, prompt: 'two' });
    await settle();

    // Despite a tiny cap of 4, the agent's own serialization holds it to 1.
    assert.equal(h.gate.inFlight(), 1);
    h.gate.releaseAll();
    await settle();
    h.gate.releaseAll();
    await settle();
    assert.equal(h.gate.peak.tiny, 1);
    assert.equal(h.reg.listTasks({ status: 'done' }).length, 2);
  } finally {
    await h.cleanup();
  }
});

test('queue: a parallel agent runs up to its own max_concurrency', async () => {
  const h = harness(8);
  try {
    const a = h.reg.create({
      name: 'par',
      systemPrompt: 'x',
      profile: 'chat',
      executionMode: 'parallel',
      maxConcurrency: 2,
      toolAllowlist: [],
    });
    h.queue.dispatch({ agentId: a.id, prompt: '1' });
    h.queue.dispatch({ agentId: a.id, prompt: '2' });
    h.queue.dispatch({ agentId: a.id, prompt: '3' });
    await settle();
    assert.equal(h.gate.inFlight(), 2);
    h.gate.releaseAll();
    await settle();
    h.gate.releaseAll();
    await settle();
    assert.equal(h.gate.peak.tiny, 2);
    assert.equal(h.reg.listTasks({ status: 'done' }).length, 3);
  } finally {
    await h.cleanup();
  }
});
