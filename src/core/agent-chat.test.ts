// Per-agent direct chat (panel DMs): a persistent conversation per agent that
// runs through the persona's orchestrator but excludes every task-run
// affordance (planning tools, delegation, the autonomous preamble).

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../storage/db.js';
import { createLogger } from '../util/log.js';
import { createToolRegistry } from './tools.js';
import type { LLM, ChatChunk, ChatOptions } from './llm.js';
import {
  createAgentRegistry,
  createAgentRuntime,
  agentDmChatId,
  isAgentChatId,
  isAgentDmChatId,
  AGENT_CHAT_ID_BASE,
} from './agents.js';

function silentLogger() {
  return createLogger({ level: 'error', out: () => {}, err: () => {} });
}

function tmp() {
  return mkdtempSync(join(tmpdir(), 'modulus-agent-chat-'));
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

// A stream that stays open until released — for exercising the busy guard.
function gatedStream(): { stream: AsyncIterable<ChatChunk>; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  async function* stream(): AsyncIterable<ChatChunk> {
    await gate;
    yield { delta: 'done waiting', done: true, model: 'fake', promptTokens: 1, completionTokens: 1 };
  }
  return { stream: stream(), release };
}

test('agentDmChatId band: distinct from the task band, still an agent chat id', () => {
  const dm = agentDmChatId(7);
  assert.ok(isAgentDmChatId(dm));
  assert.ok(isAgentChatId(dm));
  // A task virtual id is NOT a DM id.
  assert.ok(!isAgentDmChatId(AGENT_CHAT_ID_BASE + 12345));
});

test('chat: streams the persona reply, persists history on the DM chat id, accumulates context', async () => {
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    const reg = createAgentRegistry(db);
    const llm = fakeLlm([textStream(['Hi, ', 'boss.']), textStream(['Still here.'])]);
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
      name: 'helper',
      systemPrompt: 'You are the Helper.',
      profile: 'chat',
      toolAllowlist: [],
    });

    const deltas: string[] = [];
    const first = await runtime.chat(agent.id, 'Hello there', {
      onDelta: (d) => deltas.push(d),
    });
    assert.equal(first.ok, true);
    assert.equal(first.text, 'Hi, boss.');
    assert.deepEqual(deltas, ['Hi, ', 'boss.']);
    assert.match(llm.calls[0]!.messages[0]!.content, /You are the Helper\./);

    // Transcript landed on the agent's DM chat id.
    const rows = db
      .prepare(
        `SELECT m.role AS role, m.content AS content FROM messages m
          JOIN conversations c ON m.conversation_id = c.id
         WHERE c.telegram_chat_id = ? ORDER BY m.id`,
      )
      .all(agentDmChatId(agent.id)) as Array<{ role: string; content: string }>;
    assert.deepEqual(
      rows.map((r) => r.role),
      ['user', 'assistant'],
    );
    assert.equal(rows[0]!.content, 'Hello there');

    // The second turn carries the first as context — a real session, not a
    // one-shot dispatch.
    const second = await runtime.chat(agent.id, 'You still there?');
    assert.equal(second.ok, true);
    const secondContext = llm.calls[1]!.messages.map((m) => m.content).join('\n');
    assert.match(secondContext, /Hello there/);
    assert.match(secondContext, /Hi, boss\./);

    await runtime.shutdown();
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('chat: a DM with an autonomous agent gets no loop preamble', async () => {
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

    const agent = reg.create({
      name: 'worker',
      systemPrompt: 'You are the Worker.',
      mode: 'autonomous',
      canDelegate: true,
      toolAllowlist: [],
    });
    const res = await runtime.chat(agent.id, 'hey');
    assert.equal(res.ok, true);
    const system = llm.calls[0]!.messages[0]!.content;
    assert.match(system, /You are the Worker\./);
    assert.doesNotMatch(system, /AUTONOMOUS agent/);
    assert.doesNotMatch(system, /spawn_agent/);

    await runtime.shutdown();
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('chat: rejects a second send while a turn is in flight (busy guard)', async () => {
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    const reg = createAgentRegistry(db);
    const gate = gatedStream();
    const llm = fakeLlm([gate.stream]);
    const tools = createToolRegistry({ log: silentLogger() });
    const runtime = createAgentRuntime({
      db,
      llm,
      tools,
      log: silentLogger(),
      registry: reg,
      ownerUserId: 42,
    });

    const agent = reg.create({ name: 'slow', systemPrompt: 'Slow.', toolAllowlist: [] });
    const inFlight = runtime.chat(agent.id, 'first');
    // Wait until the turn reaches the model so dmActive is set.
    while (!runtime.chatBusy(agent.id)) await new Promise((r) => setTimeout(r, 5));

    const rejected = await runtime.chat(agent.id, 'second');
    assert.equal(rejected.ok, false);
    assert.match(rejected.error ?? '', /already replying/);

    gate.release();
    const first = await inFlight;
    assert.equal(first.ok, true);
    assert.equal(runtime.chatBusy(agent.id), false);

    await runtime.shutdown();
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('clearChat: wipes the DM history so the next turn starts fresh', async () => {
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    const reg = createAgentRegistry(db);
    const llm = fakeLlm([textStream(['first answer']), textStream(['fresh answer'])]);
    const tools = createToolRegistry({ log: silentLogger() });
    const runtime = createAgentRuntime({
      db,
      llm,
      tools,
      log: silentLogger(),
      registry: reg,
      ownerUserId: 42,
    });

    const agent = reg.create({ name: 'amnesiac', systemPrompt: 'Hi.', toolAllowlist: [] });
    await runtime.chat(agent.id, 'remember me');
    runtime.clearChat(agent.id);

    const count = db
      .prepare(`SELECT COUNT(*) AS n FROM conversations WHERE telegram_chat_id = ?`)
      .get(agentDmChatId(agent.id)) as { n: number };
    assert.equal(count.n, 0);

    // Next turn carries none of the wiped exchange.
    await runtime.chat(agent.id, 'who am I?');
    const context = llm.calls[1]!.messages.map((m) => m.content).join('\n');
    assert.doesNotMatch(context, /remember me/);

    await runtime.shutdown();
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
