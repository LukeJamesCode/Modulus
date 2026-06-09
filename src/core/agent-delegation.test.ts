import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../storage/db.js';
import { createLogger } from '../util/log.js';
import { createToolRegistry, type ToolContext } from './tools.js';
import type { LLM, ChatChunk, ChatOptions } from './llm.js';
import {
  createAgentRegistry,
  createAgentRuntime,
  AGENT_CHAT_ID_BASE,
  MAX_DELEGATION_DEPTH,
  SPAWN_AGENT_TOOL_NAME,
  SPAWN_AGENTS_TOOL_NAME,
} from './agents.js';
import { createAgentQueue } from './agent-queue.js';
import { setupAgentDelegation } from './agent-delegation.js';

function silentLogger() {
  return createLogger({ level: 'error', out: () => {}, err: () => {} });
}
function tmp() {
  return mkdtempSync(join(tmpdir(), 'modulus-deleg-'));
}

function fakeLlm(scripts: Array<AsyncIterable<ChatChunk>>): LLM & { calls: ChatOptions[] } {
  const calls: ChatOptions[] = [];
  let i = 0;
  const llm: LLM = {
    chat(opts) {
      calls.push(opts);
      const next = scripts[i++];
      if (!next) throw new Error('llm script exhausted');
      return next;
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

async function* textStream(text: string): AsyncIterable<ChatChunk> {
  yield { delta: text, done: true, model: 'fake', promptTokens: 5, completionTokens: 1 };
}
async function* spawnCall(args: Record<string, unknown>): AsyncIterable<ChatChunk> {
  yield {
    delta: '',
    done: false,
    toolCalls: [{ id: 's1', name: SPAWN_AGENT_TOOL_NAME, arguments: args }],
  };
  yield { delta: '', done: true, model: 'fake', promptTokens: 5, completionTokens: 1 };
}

function harness(scripts: Array<AsyncIterable<ChatChunk>>, opts: { maxParallel?: number } = {}) {
  const dir = tmp();
  const db = open({ path: join(dir, 'g.db') });
  const reg = createAgentRegistry(db);
  const llm = fakeLlm(scripts);
  const tools = createToolRegistry({ log: silentLogger() });
  const runtime = createAgentRuntime({
    db,
    llm,
    tools,
    log: silentLogger(),
    registry: reg,
    ownerUserId: 1,
  });
  const queue = createAgentQueue({ registry: reg, runtime, llm, log: silentLogger() });
  setupAgentDelegation({
    tools,
    llm,
    registry: reg,
    runtime,
    queue,
    log: silentLogger(),
    maxParallel: opts.maxParallel ?? 2,
  });
  const cleanup = async () => {
    await runtime.shutdown();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { db, reg, llm, tools, runtime, queue, cleanup };
}

test('spawn_agent (await): supervisor runs a worker and relays its result; child is linked', async () => {
  // 0: supervisor asks to delegate -> 1: worker replies -> 2: supervisor paraphrases.
  const h = harness([
    spawnCall({ agent: 'worker', task: 'gather facts', mode: 'await' }),
    textStream('worker output'),
    textStream('relayed to user'),
  ]);
  try {
    const supervisor = h.reg.create({
      name: 'supervisor',
      systemPrompt: 'You delegate.',
      profile: 'chat',
      toolAllowlist: [],
      canDelegate: true,
      delegatableAgents: ['worker'],
    });
    h.reg.create({ name: 'worker', systemPrompt: 'You work.', profile: 'chat', toolAllowlist: [] });

    const task = h.reg.enqueue({ agentId: supervisor.id, prompt: 'get me facts' });
    const result = await h.runtime.runTask(task.id);

    assert.equal(result.ok, true);
    assert.equal(result.text, 'relayed to user');

    // The worker ran as a linked child at depth 1 and recorded its own result.
    const children = h.reg.listTasks({ parentId: task.id });
    assert.equal(children.length, 1);
    assert.equal(children[0]!.depth, 1);
    assert.equal(children[0]!.status, 'done');
    assert.equal(children[0]!.result, 'worker output');

    await h.cleanup();
  } catch (e) {
    await h.cleanup();
    throw e;
  }
});

test('spawn_agent: a worker can never exceed the supervisor grant', async () => {
  const h = harness([
    spawnCall({ agent: 'worker', task: 'use a tool', mode: 'await' }),
    textStream('worker ok'), // worker turn
    textStream('done'), // supervisor paraphrase
  ]);
  try {
    h.tools.register({
      name: 'echo',
      description: 'allowed',
      parameters: {},
      tier: 'auto',
      extension: 'extA',
      invoke: async () => 'echo',
    });
    h.tools.register({
      name: 'secret',
      description: 'forbidden',
      parameters: {},
      tier: 'auto',
      extension: 'extB',
      invoke: async () => 'leaked',
    });
    const supervisor = h.reg.create({
      name: 'supervisor',
      systemPrompt: 'You delegate.',
      profile: 'chat',
      toolAllowlist: ['extA'], // supervisor may only use extA
      canDelegate: true,
      delegatableAgents: [],
    });
    // Worker is unrestricted on its own — the ceiling must come from the parent.
    h.reg.create({
      name: 'worker',
      systemPrompt: 'You work.',
      profile: 'chat',
      toolAllowlist: null,
    });

    const task = h.reg.enqueue({ agentId: supervisor.id, prompt: 'go' });
    await h.runtime.runTask(task.id);

    // calls[1] is the worker's turn. Its manifest is the intersection of the
    // parent grant (extA) and its own (all) -> echo only, never secret.
    const workerTools = (h.llm.calls[1]!.tools ?? []).map((s) => s.function.name);
    assert.deepEqual(workerTools, ['echo']);
    for (const c of h.llm.calls) {
      assert.ok(!(c.tools ?? []).some((s) => s.function.name === 'secret'));
    }

    await h.cleanup();
  } catch (e) {
    await h.cleanup();
    throw e;
  }
});

test('spawn_agent: guards reject non-delegators, bad targets, depth, and non-agent callers', async () => {
  const h = harness([]); // no LLM calls — we invoke the tool directly
  try {
    const spawn = h.tools.get(SPAWN_AGENT_TOOL_NAME)!;
    assert.ok(spawn, 'spawn_agent should be registered');

    const noDelegate = h.reg.create({
      name: 'plain',
      systemPrompt: 'x',
      canDelegate: false,
    });
    const boss = h.reg.create({
      name: 'boss',
      systemPrompt: 'x',
      canDelegate: true,
      delegatableAgents: ['only-this'],
    });
    h.reg.create({ name: 'worker', systemPrompt: 'x' });
    h.reg.create({ name: 'only-this', systemPrompt: 'x' });

    const ctxFor = (taskId: number): ToolContext => ({
      chatId: AGENT_CHAT_ID_BASE + taskId,
      log: silentLogger(),
    });

    // Non-agent chat id (e.g. a real Telegram chat) can't delegate at all.
    assert.match(
      await spawn.invoke({ agent: 'worker', task: 't' }, { chatId: 555, log: silentLogger() }),
      /only be used from within an agent run/,
    );

    // canDelegate = false.
    const t1 = h.reg.enqueue({ agentId: noDelegate.id, prompt: 'p' });
    assert.match(
      await spawn.invoke({ agent: 'worker', task: 't' }, ctxFor(t1.id)),
      /not permitted to delegate/,
    );

    // Target not in the delegatable allowlist.
    const t2 = h.reg.enqueue({ agentId: boss.id, prompt: 'p' });
    assert.match(
      await spawn.invoke({ agent: 'worker', task: 't' }, ctxFor(t2.id)),
      /may not delegate to 'worker'/,
    );

    // Depth ceiling.
    const t3 = h.reg.enqueue({ agentId: boss.id, prompt: 'p', depth: MAX_DELEGATION_DEPTH });
    assert.match(
      await spawn.invoke({ agent: 'only-this', task: 't' }, ctxFor(t3.id)),
      /depth limit/,
    );

    await h.cleanup();
  } catch (e) {
    await h.cleanup();
    throw e;
  }
});

test('spawn_agents: fans out to multiple workers and joins their labelled results', async () => {
  // Two child runs, one script each. This is the headline win — the parallel
  // pattern the docs promise ("gather X and Y at once") must actually produce
  // both results, attributed, from one supervisor tool call.
  const h = harness([textStream('calendar facts'), textStream('weather facts')]);
  try {
    const boss = h.reg.create({
      name: 'boss',
      systemPrompt: 'x',
      profile: 'chat',
      toolAllowlist: [],
      canDelegate: true,
      delegatableAgents: [],
    });
    h.reg.create({ name: 'cal', systemPrompt: 'x', profile: 'chat', toolAllowlist: [] });
    h.reg.create({ name: 'wx', systemPrompt: 'x', profile: 'chat', toolAllowlist: [] });
    const spawn = h.tools.get(SPAWN_AGENTS_TOOL_NAME)!;
    assert.ok(spawn, 'spawn_agents should be registered');

    const parent = h.reg.enqueue({ agentId: boss.id, prompt: 'plan my day' });
    const out = await spawn.invoke(
      {
        tasks: [
          { agent: 'cal', task: 'get calendar' },
          { agent: 'wx', task: 'get weather' },
        ],
      },
      { chatId: AGENT_CHAT_ID_BASE + parent.id, log: silentLogger() },
    );

    // Both subtasks are present and attributed by agent + position; the actual
    // text-to-slot mapping is irrelevant (workers may interleave), so assert
    // that both labels and both outputs landed.
    assert.match(out, /## cal \(task 1\)/);
    assert.match(out, /## wx \(task 2\)/);
    assert.ok(out.includes('calendar facts') && out.includes('weather facts'));

    const children = h.reg.listTasks({ parentId: parent.id });
    assert.equal(children.length, 2, 'both workers ran as linked children');
    assert.ok(
      children.every((c) => c.status === 'done' && c.depth === 1),
      'children finished at depth 1',
    );

    await h.cleanup();
  } catch (e) {
    await h.cleanup();
    throw e;
  }
});

test('spawn_agents: refuses a heavy (reasoning) worker to avoid a parallel-slot deadlock', async () => {
  // A heavy target can never get a model slot while the supervisor holds one,
  // so the batch is rejected up front and nothing is spawned.
  const h = harness([]);
  try {
    const boss = h.reg.create({
      name: 'boss',
      systemPrompt: 'x',
      canDelegate: true,
      delegatableAgents: [],
    });
    h.reg.create({ name: 'thinker', systemPrompt: 'x', profile: 'reason' });
    const spawn = h.tools.get(SPAWN_AGENTS_TOOL_NAME)!;
    const parent = h.reg.enqueue({ agentId: boss.id, prompt: 'p' });

    const out = await spawn.invoke(
      { tasks: [{ agent: 'thinker', task: 'think hard' }] },
      { chatId: AGENT_CHAT_ID_BASE + parent.id, log: silentLogger() },
    );
    assert.match(out, /heavy reasoning model/);
    assert.equal(
      h.reg.listTasks({ parentId: parent.id }).length,
      0,
      'a rejected batch spawns nothing',
    );

    await h.cleanup();
  } catch (e) {
    await h.cleanup();
    throw e;
  }
});

test('spawn_agents: a worker can never exceed the supervisor grant', async () => {
  const h = harness([textStream('did it')], { maxParallel: 1 });
  try {
    h.tools.register({
      name: 'echo',
      description: 'allowed',
      parameters: {},
      tier: 'auto',
      extension: 'extA',
      invoke: async () => 'echo',
    });
    h.tools.register({
      name: 'secret',
      description: 'forbidden',
      parameters: {},
      tier: 'auto',
      extension: 'extB',
      invoke: async () => 'leaked',
    });
    const boss = h.reg.create({
      name: 'boss',
      systemPrompt: 'x',
      profile: 'chat',
      toolAllowlist: ['extA'], // supervisor may only use extA
      canDelegate: true,
      delegatableAgents: [],
    });
    h.reg.create({ name: 'worker', systemPrompt: 'x', profile: 'chat', toolAllowlist: null });
    const spawn = h.tools.get(SPAWN_AGENTS_TOOL_NAME)!;
    const parent = h.reg.enqueue({ agentId: boss.id, prompt: 'go' });

    await spawn.invoke(
      { tasks: [{ agent: 'worker', task: 'use a tool' }] },
      { chatId: AGENT_CHAT_ID_BASE + parent.id, log: silentLogger() },
    );

    // The worker's manifest is the intersection of the parent grant (extA) and
    // its own (all) → echo only, never the supervisor-forbidden secret.
    const workerTools = (h.llm.calls[0]!.tools ?? []).map((s) => s.function.name);
    assert.deepEqual(workerTools, ['echo']);

    await h.cleanup();
  } catch (e) {
    await h.cleanup();
    throw e;
  }
});
