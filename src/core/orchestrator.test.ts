import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../storage/db.js';
import { createOrchestrator, type ReplyChunk } from './orchestrator.js';
import { createToolRegistry } from './tools.js';
import { createLogger } from '../util/log.js';
import type { LLM, ChatChunk, ChatOptions } from './llm.js';

function silentLogger() {
  return createLogger({ level: 'error', out: () => {}, err: () => {} });
}

function tmp() {
  return mkdtempSync(join(tmpdir(), 'modulus-orch-'));
}

function fakeLlm(
  scripts: Array<AsyncIterable<ChatChunk> | (() => AsyncIterable<ChatChunk>)>,
  profiles?: ReturnType<LLM['listProfiles']>,
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
      return (
        profiles ?? {
          chat: { model: 'fake', contextTokens: 4096, heavy: false },
          reason: null,
          tools: null,
        }
      );
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

async function* stream(parts: string[]): AsyncIterable<ChatChunk> {
  for (let i = 0; i < parts.length; i++) {
    const last = i === parts.length - 1;
    yield {
      delta: parts[i]!,
      done: last,
      ...(last ? { promptTokens: 5, completionTokens: parts.length, model: 'fake' } : {}),
    };
  }
}

test('handleUserMessage streams a reply and persists user+assistant messages', async () => {
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    const llm = fakeLlm([stream(['Hi ', 'there.'])]);
    const tools = createToolRegistry({ log: silentLogger() });
    const orch = createOrchestrator({ db, llm, tools, log: silentLogger() });

    const chunks: ReplyChunk[] = [];
    await orch.handleUserMessage({
      chatId: 100,
      userId: 1,
      text: 'Hello',
      send: async (c) => {
        chunks.push(c);
      },
    });

    assert.ok(chunks.some((c) => c.delta === 'Hi '));
    // Regression: Ollama sometimes ships the last token on the same chunk as
    // done=true. The orchestrator must still forward that delta, otherwise
    // the Telegram buffer ends up empty and the user sees "(no reply)".
    assert.ok(chunks.some((c) => c.delta === 'there.'));
    const final = chunks[chunks.length - 1]!;
    assert.equal(final.done, true);
    assert.equal(final.meta?.model, 'fake');

    const messages = db
      .prepare(
        `SELECT role, content FROM messages WHERE conversation_id = (
          SELECT current_conversation_id FROM telegram_chats WHERE chat_id = 100
        ) ORDER BY id`,
      )
      .all() as Array<{ role: string; content: string }>;
    assert.deepEqual(
      messages.map((m) => m.role),
      ['user', 'assistant'],
    );
    assert.equal(messages[0]!.content, 'Hello');
    assert.equal(messages[1]!.content, 'Hi there.');
    await orch.shutdown();
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a per-message thinkMode is forwarded to llm.chat', async () => {
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    const llm = fakeLlm([stream(['ok'])]);
    const tools = createToolRegistry({ log: silentLogger() });
    const orch = createOrchestrator({ db, llm, tools, log: silentLogger() });
    await orch.handleUserMessage({
      chatId: 1,
      userId: 1,
      text: 'Hello',
      thinkMode: 'on',
      send: () => {},
    });
    assert.equal(llm.calls[0]!.thinkMode, 'on');
    await orch.shutdown();
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('defaultThinkMode applies when a message has none; the message overrides it', async () => {
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    const llm = fakeLlm([stream(['a']), stream(['b'])]);
    const tools = createToolRegistry({ log: silentLogger() });
    const orch = createOrchestrator({
      db,
      llm,
      tools,
      log: silentLogger(),
      defaultThinkMode: 'off',
    });
    // No per-message thinkMode => the orchestrator default is used.
    await orch.handleUserMessage({ chatId: 1, userId: 1, text: 'a', send: () => {} });
    assert.equal(llm.calls[0]!.thinkMode, 'off');
    // A per-message thinkMode wins over the default.
    await orch.handleUserMessage({
      chatId: 1,
      userId: 1,
      text: 'b',
      thinkMode: 'on',
      send: () => {},
    });
    assert.equal(llm.calls[1]!.thinkMode, 'on');
    await orch.shutdown();
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handleUserMessage resolves only after the final reply chunk is sent', async () => {
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    const llm = fakeLlm([stream(['voice ', 'hook'])]);
    const tools = createToolRegistry({ log: silentLogger() });
    const orch = createOrchestrator({ db, llm, tools, log: silentLogger() });

    const chunks: ReplyChunk[] = [];
    await orch.handleUserMessage({
      chatId: 101,
      userId: 1,
      text: 'Hello',
      send: async (c) => {
        chunks.push(c);
      },
    });

    assert.equal(chunks.at(-1)?.done, true);
    assert.equal(chunks.map((c) => c.delta).join(''), 'voice hook');
    await orch.shutdown();
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('newChat ends the current conversation so the next message starts a fresh one', async () => {
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    const llm = fakeLlm([stream(['ok']), stream(['ok2'])]);
    const tools = createToolRegistry({ log: silentLogger() });
    const orch = createOrchestrator({ db, llm, tools, log: silentLogger() });
    await orch.handleUserMessage({ chatId: 1, userId: 1, text: 'a', send: () => {} });
    await orch.shutdown();

    orch.newChat(1);

    // Re-create orchestrator (simulate restart) so we can issue another message.
    const orch2 = createOrchestrator({ db, llm, tools, log: silentLogger() });
    await orch2.handleUserMessage({ chatId: 1, userId: 1, text: 'b', send: () => {} });
    await orch2.shutdown();

    const convs = db
      .prepare(`SELECT id, ended_at FROM conversations WHERE telegram_chat_id = 1 ORDER BY id`)
      .all() as Array<{ id: number; ended_at: number | null }>;
    assert.equal(convs.length, 2, 'expected two conversations after /newchat');
    assert.ok(convs[0]!.ended_at !== null);
    assert.ok(convs[1]!.ended_at === null);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function* toolCallStream(
  name: string,
  args: Record<string, unknown>,
): AsyncIterable<ChatChunk> {
  yield {
    delta: '',
    done: true,
    model: 'fake',
    toolCalls: [{ id: `call_${name}`, name, arguments: args }],
    promptTokens: 5,
    completionTokens: 1,
  };
}

// Mirrors Ollama's real wire shape: the tool-call chunk arrives with
// done=false, then a separate done=true chunk with no tool_calls follows.
async function* splitToolCallStream(
  name: string,
  args: Record<string, unknown>,
): AsyncIterable<ChatChunk> {
  yield {
    delta: '',
    done: false,
    model: 'fake',
    toolCalls: [{ id: `call_${name}`, name, arguments: args }],
  };
  yield {
    delta: '',
    done: true,
    model: 'fake',
    promptTokens: 5,
    completionTokens: 1,
  };
}

test('split tool-call stream: tool_calls on a non-done chunk still trigger the loop', async () => {
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    const llm = fakeLlm([splitToolCallStream('ping', {}), stream(['done.'])]);
    const tools = createToolRegistry({ log: silentLogger() });
    let invoked = 0;
    tools.register({
      name: 'ping',
      description: 'noop',
      tier: 'auto',
      parameters: { type: 'object', properties: {} },
      invoke: async () => {
        invoked += 1;
        return 'pong';
      },
    });
    const orch = createOrchestrator({ db, llm, tools, log: silentLogger() });

    const chunks: ReplyChunk[] = [];
    await orch.handleUserMessage({
      chatId: 9,
      userId: 1,
      text: 'hi',
      send: async (c) => {
        chunks.push(c);
      },
    });
    await orch.shutdown();

    assert.equal(invoked, 1, 'tool must run even when tool_calls arrive before done=true');
    assert.ok(
      chunks.some((c) => c.delta === 'done.'),
      'follow-up text after the split tool call must reach the sink',
    );
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('chained tool calls: orchestrator loops until the model produces text', async () => {
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    // Round 1: tool call. Round 2: tool call again. Round 3: real text reply.
    const llm = fakeLlm([
      toolCallStream('ping', { n: 1 }),
      toolCallStream('ping', { n: 2 }),
      stream(['done.']),
    ]);
    const tools = createToolRegistry({ log: silentLogger() });
    tools.register({
      name: 'ping',
      description: 'noop',
      tier: 'auto',
      parameters: { type: 'object', properties: {} },
      invoke: async () => 'pong',
    });
    const orch = createOrchestrator({ db, llm, tools, log: silentLogger() });

    const chunks: ReplyChunk[] = [];
    await orch.handleUserMessage({
      chatId: 7,
      userId: 1,
      text: 'hi',
      send: async (c) => {
        chunks.push(c);
      },
    });
    await orch.shutdown();

    // The text from the third round must reach the Telegram sink.
    assert.ok(
      chunks.some((c) => c.delta === 'done.'),
      'expected the chained-tool follow-up text to be streamed to the sink',
    );
    assert.equal(llm.calls.length, 3, 'expected three LLM rounds');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runaway tool loop: bail out and re-call without tools so the user gets a reply', async () => {
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    // Five rounds of tool calls (over MAX) then a tool-free fallback reply.
    const llm = fakeLlm([
      toolCallStream('ping', {}),
      toolCallStream('ping', {}),
      toolCallStream('ping', {}),
      toolCallStream('ping', {}),
      toolCallStream('ping', {}),
      stream(['fallback reply.']),
    ]);
    const tools = createToolRegistry({ log: silentLogger() });
    tools.register({
      name: 'ping',
      description: 'noop',
      tier: 'auto',
      parameters: { type: 'object', properties: {} },
      invoke: async () => 'pong',
    });
    const orch = createOrchestrator({ db, llm, tools, log: silentLogger() });

    const chunks: ReplyChunk[] = [];
    await orch.handleUserMessage({
      chatId: 8,
      userId: 1,
      text: 'go',
      send: async (c) => {
        chunks.push(c);
      },
    });
    await orch.shutdown();

    assert.ok(
      chunks.some((c) => c.delta === 'fallback reply.'),
      'expected the no-tools fallback to deliver text to the sink',
    );
    // The last call must have had tools omitted (the safety-net fallback).
    const last = llm.calls[llm.calls.length - 1]!;
    assert.equal(last.tools, undefined, 'fallback round must disable tools');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('final chunk includes after-turn context with summarized tool calls', async () => {
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    const longResult = 'x'.repeat(900);
    const llm = fakeLlm([toolCallStream('lookup', { q: 'pattern' }), stream(['learned.'])]);
    const tools = createToolRegistry({ log: silentLogger() });
    tools.register({
      name: 'lookup',
      description: 'lookup pattern',
      tier: 'auto',
      parameters: { type: 'object', properties: { q: { type: 'string' } } },
      invoke: async () => longResult,
    });
    const orch = createOrchestrator({ db, llm, tools, log: silentLogger() });

    const chunks: ReplyChunk[] = [];
    await orch.handleUserMessage({
      chatId: 77,
      userId: 11,
      text: 'find a pattern',
      send: async (c) => {
        chunks.push(c);
      },
    });
    await orch.shutdown();

    const turn = chunks.at(-1)?.meta?.afterTurn;
    assert.ok(turn, 'final chunk should include after-turn context');
    assert.equal(turn.chatId, 77);
    assert.equal(turn.userId, 11);
    assert.equal(turn.userText, 'find a pattern');
    assert.equal(turn.assistantText, 'learned.');
    assert.equal(turn.toolCalls.length, 1);
    assert.equal(turn.toolCalls[0]!.name, 'lookup');
    assert.deepEqual(turn.toolCalls[0]!.arguments, { q: 'pattern' });
    assert.equal(turn.toolCalls[0]!.ok, true);
    assert.ok(turn.toolCalls[0]!.resultSummary.length < longResult.length);
    assert.match(turn.toolCalls[0]!.resultSummary, /truncated/);
    assert.ok(turn.startedAt <= turn.finishedAt);
    assert.ok(turn.conversationId > 0);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('self-replying tool short-circuit persists the assistant turn exactly once', async () => {
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    // One round: a self-replying tool, no follow-up LLM call needed.
    const llm = fakeLlm([toolCallStream('add_event', { title: 'lunch' })]);
    const tools = createToolRegistry({ log: silentLogger() });
    tools.register({
      name: 'add_event',
      description: 'add an event',
      tier: 'auto',
      selfReplying: true,
      parameters: { type: 'object', properties: { title: { type: 'string' } } },
      invoke: async (args) => `Added: ${(args as { title: string }).title}`,
    });
    const orch = createOrchestrator({ db, llm, tools, log: silentLogger() });

    await orch.handleUserMessage({ chatId: 42, userId: 1, text: 'add lunch', send: () => {} });
    await orch.shutdown();

    const rows = db
      .prepare(
        `SELECT role, content, tool_calls_json FROM messages WHERE conversation_id = (
          SELECT current_conversation_id FROM telegram_chats WHERE chat_id = 42
        ) ORDER BY id`,
      )
      .all() as Array<{ role: string; content: string; tool_calls_json: string | null }>;
    // Well-formed turn, same shape as the non-short-circuit path:
    //   user → assistant(tool_calls) → tool → assistant(text)
    // The tool-call request row must be persisted so the tool result isn't
    // orphaned — a `tool` with no preceding assistant `tool_calls` duplicates
    // the output in next-turn context and is rejected by strict OpenAI-
    // compatible routed providers.
    assert.deepEqual(
      rows.map((r) => r.role),
      ['user', 'assistant', 'tool', 'assistant'],
    );
    assert.ok(rows[1]!.tool_calls_json, 'assistant tool-call request must carry tool_calls');
    assert.equal(rows[1]!.content, '');
    // The self-replying output is written exactly once as the final text reply.
    // Earlier versions double-wrote it (short-circuit + post-loop block).
    const textRows = rows.filter((r) => r.role === 'assistant' && r.content === 'Added: lunch');
    assert.equal(textRows.length, 1, 'self-replying reply text persisted once');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an empty tiny-model reply escalates the recovery retry to the reason model', async () => {
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    // WHY this matters: the tiny chat model occasionally returns nothing
    // usable. The recovery retry is the ONLY place the main chat path can reach
    // the heavy 9B, and it fires exactly when quality has already failed — so
    // on a host that has a reason model configured (Standard/Heavy tier) the
    // retry must go to `reason`, not re-ask the same tiny model that just
    // whiffed. If this assertion can't fail, escalation has silently regressed
    // back to defaultProfile and the heavy model is dead weight again.
    const llm = fakeLlm([stream(['']), stream(['recovered'])], {
      chat: { model: 'tiny', contextTokens: 4096, heavy: false },
      reason: { model: 'heavy-9b', contextTokens: 8192, heavy: true },
      tools: null,
    });
    const tools = createToolRegistry({ log: silentLogger() });
    const orch = createOrchestrator({ db, llm, tools, log: silentLogger() });
    await orch.handleUserMessage({ chatId: 7, userId: 1, text: 'a hard question', send: () => {} });
    await orch.shutdown();

    assert.equal(llm.calls.length, 2, 'expected an initial round plus one recovery retry');
    assert.equal(llm.calls[0]!.profile, 'chat', 'initial round uses the tiny chat profile');
    assert.equal(llm.calls[1]!.profile, 'reason', 'recovery retry escalates to the heavy model');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('escalation is a no-op when no reason model is configured (Small tier)', async () => {
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    // The default profiles have reason:null (a Pi with no heavy model). The
    // recovery retry must fall back to the chat profile, never name a profile
    // the host can't serve — escalation is strictly opt-in via configuration.
    const llm = fakeLlm([stream(['']), stream(['recovered'])]);
    const tools = createToolRegistry({ log: silentLogger() });
    const orch = createOrchestrator({ db, llm, tools, log: silentLogger() });
    await orch.handleUserMessage({ chatId: 8, userId: 1, text: 'a hard question', send: () => {} });
    await orch.shutdown();

    assert.equal(llm.calls.length, 2);
    assert.equal(llm.calls[1]!.profile, 'chat', 'no reason model → retry stays on chat');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
