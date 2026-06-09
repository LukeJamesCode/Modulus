import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../storage/db.js';
import { createLogger } from '../util/log.js';
import { createToolRegistry } from './tools.js';
import type { LLM, ChatChunk, ChatOptions } from './llm.js';
import { LLMTimeoutError } from './llm.js';
import {
  createAgentRegistry,
  createAgentRuntime,
  filterToolRegistry,
  agentToolPredicate,
  seedStarterAgents,
  AGENT_CHAT_ID_BASE,
  AGENT_TASK_CANCELLED_MESSAGE,
} from './agents.js';

function silentLogger() {
  return createLogger({ level: 'error', out: () => {}, err: () => {} });
}

function tmp() {
  return mkdtempSync(join(tmpdir(), 'modulus-agents-'));
}

function fakeLlm(
  scripts: Array<AsyncIterable<ChatChunk> | (() => AsyncIterable<ChatChunk>)>,
): LLM & { calls: ChatOptions[] } {
  const calls: ChatOptions[] = [];
  let i = 0;
  const llm: LLM = {
    chat(opts) {
      calls.push(opts);
      const next = scripts[i++];
      if (!next) throw new Error('llm script exhausted');
      return typeof next === 'function' ? next() : next;
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
    resolveModel() {
      return 'fake';
    },
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

async function* textStream(parts: string[]): AsyncIterable<ChatChunk> {
  for (let i = 0; i < parts.length; i++) {
    const last = i === parts.length - 1;
    yield {
      delta: parts[i]!,
      done: last,
      ...(last ? { promptTokens: 5, completionTokens: parts.length, model: 'fake' } : {}),
    };
  }
}

async function* abortableStream(signal?: AbortSignal): AsyncIterable<ChatChunk> {
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      reject(e);
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    void resolve;
  });
  yield { delta: 'late', done: true, model: 'fake', promptTokens: 1, completionTokens: 1 };
}

// A round that hits the per-inference cap before emitting anything — the
// faithful shape of a timeout: the error surfaces while the stream is drained,
// not before. The trailing yield is unreachable but keeps this a valid
// generator (satisfies require-yield without static-unreachable warnings).
async function* timeoutStream(): AsyncIterable<ChatChunk> {
  const fail = true;
  if (fail) throw new LLMTimeoutError(1000);
  yield { delta: '', done: true };
}

// A streamed round that asks for a single tool call, then a terminal chunk.
async function* toolCallStream(
  name: string,
  args: Record<string, unknown>,
): AsyncIterable<ChatChunk> {
  yield { delta: '', done: false, toolCalls: [{ id: 't1', name, arguments: args }] };
  yield { delta: '', done: true, model: 'fake', promptTokens: 5, completionTokens: 1 };
}

test('AgentRegistry: create/get/update/remove round-trips every field', () => {
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    const reg = createAgentRegistry(db);

    const created = reg.create({
      name: 'planner',
      role: 'decompose work',
      systemPrompt: 'You plan.',
      toolAllowlist: ['modulus-everyday-assistant'],
      profile: 'reason',
      thinkMode: 'on',
      maxToolRounds: 6,
      budgetTokens: 8192,
      executionMode: 'sequential',
      maxConcurrency: 1,
      canDelegate: true,
      delegatableAgents: ['researcher'],
    });
    assert.equal(created.name, 'planner');
    assert.deepEqual(created.toolAllowlist, ['modulus-everyday-assistant']);
    assert.equal(created.profile, 'reason');
    assert.equal(created.thinkMode, 'on');
    assert.equal(created.canDelegate, true);
    assert.deepEqual(created.delegatableAgents, ['researcher']);

    // getByName and list see it.
    assert.equal(reg.getByName('planner')?.id, created.id);
    assert.equal(reg.list().length, 1);

    // A null allowlist (= all tools) is distinct from [] (= no tools) and must
    // survive the round-trip — this is the difference between an unrestricted
    // agent and a chat-only one.
    const open2 = reg.create({ name: 'open', systemPrompt: 'hi', toolAllowlist: null });
    assert.equal(open2.toolAllowlist, null);
    // thinkMode defaults to 'auto' when unspecified.
    assert.equal(open2.thinkMode, 'auto');
    const locked = reg.create({ name: 'locked', systemPrompt: 'hi', toolAllowlist: [] });
    assert.deepEqual(locked.toolAllowlist, []);

    const updated = reg.update(created.id, {
      role: 'new role',
      canDelegate: false,
      thinkMode: 'off',
    });
    assert.equal(updated?.role, 'new role');
    assert.equal(updated?.canDelegate, false);
    assert.equal(updated?.thinkMode, 'off');
    // Unpatched fields are preserved.
    assert.equal(updated?.profile, 'reason');

    assert.equal(reg.remove(created.id), true);
    assert.equal(reg.get(created.id), undefined);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AgentRegistry: tasks enqueue, list by status, and transition', () => {
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    const reg = createAgentRegistry(db);
    const agent = reg.create({ name: 'a', systemPrompt: 'hi' });

    const t1 = reg.enqueue({ agentId: agent.id, prompt: 'first' });
    reg.enqueue({ agentId: agent.id, prompt: 'second', priority: 5 });
    assert.equal(t1.status, 'queued');
    assert.equal(reg.listTasks({ status: 'queued' }).length, 2);

    reg.updateTask(t1.id, { status: 'done', result: 'ok', finishedAt: Date.now() });
    assert.equal(reg.getTask(t1.id)?.status, 'done');
    assert.equal(reg.getTask(t1.id)?.result, 'ok');
    assert.equal(reg.listTasks({ status: 'queued' }).length, 1);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('seedStarterAgents: seeds a fleet once and is idempotent', () => {
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    const reg = createAgentRegistry(db);
    seedStarterAgents(reg);
    const names = reg
      .list()
      .map((a) => a.name)
      .sort();
    assert.deepEqual(names, ['critic', 'operator', 'orchestrator', 'researcher', 'writer']);
    // The orchestrator is the heavy delegator and can choose any fleet agent.
    const orchestrator = reg.getByName('orchestrator')!;
    assert.equal(orchestrator.profile, 'reason');
    assert.equal(orchestrator.canDelegate, true);
    assert.deepEqual(orchestrator.delegatableAgents, []);

    // The operator is the flagship autonomous agent (plan->act->reflect loop).
    const operator = reg.getByName('operator')!;
    assert.equal(operator.mode, 'autonomous');
    assert.equal(operator.canDelegate, true);
    assert.ok((operator.maxTotalRounds ?? 0) > 0);

    // Running again is a no-op (so deleting a starter agent sticks).
    seedStarterAgents(reg);
    assert.equal(reg.list().length, 5);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('seedStarterAgents: adds the orchestrator to an existing fleet once', () => {
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    const reg = createAgentRegistry(db);
    reg.create({ name: 'specialist', systemPrompt: 'x' });
    seedStarterAgents(reg);
    assert.ok(reg.getByName('orchestrator'));
    assert.equal(reg.list().length, 2);
    seedStarterAgents(reg);
    assert.equal(reg.list().length, 2);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('filterToolRegistry: scopes by tool name or extension and fails closed on execute', async () => {
  const base = createToolRegistry({ log: silentLogger() });
  base.register({
    name: 'echo',
    description: 'echo',
    parameters: {},
    tier: 'auto',
    extension: 'extA',
    invoke: async () => 'echoed',
  });
  base.register({
    name: 'secret',
    description: 'secret',
    parameters: {},
    tier: 'auto',
    extension: 'extB',
    invoke: async () => 'should never run',
  });

  // Allow by extension name.
  const byExt = filterToolRegistry(base, agentToolPredicate(['extA']));
  assert.deepEqual(
    byExt.list().map((h) => h.name),
    ['echo'],
  );
  assert.deepEqual(
    byExt.schemas().map((s) => s.function.name),
    ['echo'],
  );
  assert.equal(byExt.get('secret'), undefined);

  // A hidden tool must fail closed even if its name is forced past the manifest
  // — this is the guard that stops a delegated worker reaching a tool outside
  // its grant via an auto-routed/forced call.
  const res = await byExt.execute(
    { id: 'x', name: 'secret', arguments: {} },
    { log: silentLogger() },
  );
  assert.equal(res.ok, false);
  assert.match(res.output, /not available/);

  // null allowlist = everything.
  assert.equal(filterToolRegistry(base, agentToolPredicate(null)).list().length, 2);
});

test('AgentRuntime: runs a task headlessly, honors the persona prompt + profile, persists the result', async () => {
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    const reg = createAgentRegistry(db);
    const llm = fakeLlm([textStream(['Plan: ', 'do X.'])]);
    const tools = createToolRegistry({ log: silentLogger() });
    const runtime = createAgentRuntime({
      db,
      llm,
      tools,
      log: silentLogger(),
      registry: reg,
      ownerUserId: 42,
    });

    const agent = reg.create({
      name: 'planner',
      systemPrompt: 'You are the Planner.',
      profile: 'reason',
      toolAllowlist: [], // chat-only persona: no tools this turn
    });
    const task = reg.enqueue({ agentId: agent.id, prompt: 'Plan my week' });

    const result = await runtime.runTask(task.id);
    assert.equal(result.ok, true);
    assert.equal(result.text, 'Plan: do X.');

    // The persona's system prompt and chosen profile reached the model.
    assert.match(llm.calls[0]!.messages[0]!.content, /You are the Planner\./);
    assert.equal(llm.calls[0]!.profile, 'reason');

    // Task row reflects the terminal state + the conversation it produced.
    const persisted = reg.getTask(task.id)!;
    assert.equal(persisted.status, 'done');
    assert.equal(persisted.result, 'Plan: do X.');
    assert.equal(persisted.virtualChatId, AGENT_CHAT_ID_BASE + task.id);
    assert.ok(persisted.conversationId);

    // Transcript landed under the reserved virtual chat id.
    const msgs = db
      .prepare(`SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id`)
      .all(persisted.conversationId) as Array<{ role: string; content: string }>;
    assert.deepEqual(
      msgs.map((m) => m.role),
      ['user', 'assistant'],
    );
    assert.equal(msgs[0]!.content, 'Plan my week');

    await runtime.shutdown();
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AgentRuntime: an inference timeout fails the task loudly, not a silent empty done', async () => {
  // Why this matters: a slow model that blows the per-inference cap aborts
  // through the same low-level path as a user /stop. Before, the orchestrator
  // mistook it for a cancellation, streamed nothing, and the task was saved as
  // `done` with an empty result — the bug behind a 12B research agent "stopping"
  // with no output. A timeout must instead surface as an error so it's visible.
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    const reg = createAgentRegistry(db);
    // The model call dies with a timeout instead of streaming a reply.
    const llm = fakeLlm([timeoutStream()]);
    const tools = createToolRegistry({ log: silentLogger() });
    const runtime = createAgentRuntime({
      db,
      llm,
      tools,
      log: silentLogger(),
      registry: reg,
      ownerUserId: 7,
    });
    const agent = reg.create({
      name: 'slowpoke',
      systemPrompt: 'You are slow.',
      profile: 'reason',
      toolAllowlist: [],
    });
    const task = reg.enqueue({ agentId: agent.id, prompt: 'research the world' });

    const result = await runtime.runTask(task.id);
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /timed out/);

    const persisted = reg.getTask(task.id)!;
    assert.equal(persisted.status, 'error');
    assert.match(persisted.error ?? '', /timed out/);

    await runtime.shutdown();
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AgentRuntime: per-run thinkMode overrides the agent default; null inherits it', async () => {
  // Why this matters: a dispatch (or workflow node) can flip reasoning on/off
  // for a single run without editing the agent. The override has to win over
  // the persona's saved think mode AND actually reach the model call — that's
  // the whole point of the toggle. A stored null must leave the agent default
  // in force.
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    const reg = createAgentRegistry(db);
    // Two streams: one per run below, in dispatch order.
    const llm = fakeLlm([textStream(['a']), textStream(['b'])]);
    const tools = createToolRegistry({ log: silentLogger() });
    const runtime = createAgentRuntime({
      db,
      llm,
      tools,
      log: silentLogger(),
      registry: reg,
      ownerUserId: 7,
    });

    // Agent saved as no-think; a per-run 'on' must override it.
    const agent = reg.create({
      name: 'thinker',
      systemPrompt: 'You think on demand.',
      profile: 'reason',
      toolAllowlist: [],
      thinkMode: 'off',
    });

    const overridden = reg.enqueue({ agentId: agent.id, prompt: 'q1', thinkMode: 'on' });
    assert.equal(reg.getTask(overridden.id)!.thinkMode, 'on');
    await runtime.runTask(overridden.id);
    assert.equal(llm.calls[0]!.thinkMode, 'on');

    // No override (null) → the agent's saved 'off' reaches the model.
    const inherited = reg.enqueue({ agentId: agent.id, prompt: 'q2' });
    assert.equal(reg.getTask(inherited.id)!.thinkMode, null);
    await runtime.runTask(inherited.id);
    assert.equal(llm.calls[1]!.thinkMode, 'off');

    await runtime.shutdown();
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AgentRuntime: delegating agents see the allowed live roster in their prompt', async () => {
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    const reg = createAgentRegistry(db);
    const llm = fakeLlm([textStream(['ok'])]);
    const tools = createToolRegistry({ log: silentLogger() });
    const runtime = createAgentRuntime({
      db,
      llm,
      tools,
      log: silentLogger(),
      registry: reg,
      ownerUserId: 42,
    });
    const orchestrator = reg.create({
      name: 'orchestrator',
      systemPrompt: 'Coordinate work.',
      canDelegate: true,
      delegatableAgents: [],
      toolAllowlist: [],
    });
    reg.create({
      name: 'researcher',
      role: 'Finds facts',
      systemPrompt: 'research',
      toolAllowlist: [],
    });
    reg.create({ name: 'writer', role: 'Writes prose', systemPrompt: 'write', toolAllowlist: [] });
    const task = reg.enqueue({ agentId: orchestrator.id, prompt: 'make a plan' });

    await runtime.runTask(task.id);
    const system = llm.calls[0]!.messages[0]!.content;
    assert.match(system, /Available delegate agents/);
    assert.match(system, /researcher: Finds facts/);
    assert.match(system, /writer: Writes prose/);
    assert.doesNotMatch(system, /orchestrator:/);
    await runtime.shutdown();
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AgentRuntime: cancelling a running task aborts the active orchestrator turn', async () => {
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    const reg = createAgentRegistry(db);
    const llm = fakeLlm([() => abortableStream(llm.calls[0]?.signal)]);
    const tools = createToolRegistry({ log: silentLogger() });
    const runtime = createAgentRuntime({
      db,
      llm,
      tools,
      log: silentLogger(),
      registry: reg,
      ownerUserId: 42,
    });
    const agent = reg.create({ name: 'worker', systemPrompt: 'work', toolAllowlist: [] });
    const task = reg.enqueue({ agentId: agent.id, prompt: 'slow work' });

    const running = runtime.runTask(task.id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(runtime.cancelTask(task.id), true);
    const result = await running;

    assert.equal(result.ok, false);
    assert.equal(result.error, AGENT_TASK_CANCELLED_MESSAGE);
    assert.equal(reg.getTask(task.id)?.status, 'cancelled');
    assert.equal(llm.calls[0]?.signal?.aborted, true);
    await runtime.shutdown();
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AgentRuntime: the per-turn tool manifest is limited to the agent allowlist', async () => {
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    const reg = createAgentRegistry(db);
    // The model asks for the allowed self-replying tool; one round, no follow-up.
    const llm = fakeLlm([toolCallStream('echo', { text: 'hi' })]);
    const tools = createToolRegistry({ log: silentLogger() });
    tools.register({
      name: 'echo',
      description: 'echo input',
      parameters: {},
      tier: 'auto',
      extension: 'extA',
      selfReplying: true,
      invoke: async () => 'echoed: hi',
    });
    tools.register({
      name: 'secret',
      description: 'must stay hidden',
      parameters: {},
      tier: 'auto',
      extension: 'extB',
      invoke: async () => 'leaked',
    });
    const runtime = createAgentRuntime({
      db,
      llm,
      tools,
      log: silentLogger(),
      registry: reg,
      ownerUserId: 1,
    });

    const agent = reg.create({
      name: 'echoer',
      systemPrompt: 'You echo.',
      profile: 'tools',
      toolAllowlist: ['extA'],
    });
    const task = reg.enqueue({ agentId: agent.id, prompt: 'say hi' });
    const result = await runtime.runTask(task.id);

    // The allowed tool ran and its output became the task result.
    assert.equal(result.ok, true);
    assert.equal(reg.getTask(task.id)!.result, 'echoed: hi');

    // The model only ever saw the allowed tool — `secret` was never on the wire.
    const offered = (llm.calls[0]!.tools ?? []).map((s) => s.function.name);
    assert.deepEqual(offered, ['echo']);

    await runtime.shutdown();
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
