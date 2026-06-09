// Tests for the confirm-tier tool gate wired into the Telegram adapter.
// Uses a minimal fake Bot (via botFactory) so we can drive the Yes/No flow
// without a live grammY connection.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createTelegram, splitForTelegram, type TelegramOptions } from './telegram.js';
import type { Logger } from '../util/log.js';
import type { ToolHandler, ToolContext } from '../core/tools.js';

test('splitForTelegram leaves short text as a single piece', () => {
  assert.deepEqual(splitForTelegram('hello'), ['hello']);
});

test('splitForTelegram chunks long text under the limit, never exceeding it', () => {
  const long = 'x'.repeat(10_000);
  const parts = splitForTelegram(long, 4000);
  assert.ok(parts.length >= 3);
  for (const p of parts) assert.ok(p.length <= 4000, `part too long: ${p.length}`);
  assert.equal(parts.join('').length, long.length);
});

test('splitForTelegram prefers a newline boundary near the limit', () => {
  // 3990 chars, a newline, then more — the first chunk should end at the newline.
  const head = 'a'.repeat(3990);
  const tail = 'b'.repeat(500);
  const parts = splitForTelegram(`${head}\n${tail}`, 4000);
  assert.equal(parts[0], head);
  assert.equal(parts[1], tail);
});

test('splitForTelegram never emits an empty/whitespace-only part', () => {
  // A run of blank lines straddling the boundary used to produce an empty
  // chunk, which the send loop then handed to ctx.reply('') — Telegram 400s on
  // empty text, truncating the rest of a long reply.
  const text = 'a'.repeat(3990) + '\n'.repeat(60) + 'b'.repeat(3990);
  const parts = splitForTelegram(text, 4000);
  for (const p of parts)
    assert.ok(p.trim().length > 0, `empty part produced: ${JSON.stringify(p)}`);
  assert.ok(parts.length >= 2);
});

function silentLogger(): Logger {
  const noop = (): void => {};
  const l: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => l,
  };
  return l;
}

interface FakeBot {
  bot: unknown;
  handlers: Map<string, (ctx: unknown) => Promise<void> | void>;
  sent: Array<{ chatId: number; text: string }>;
  edits: Array<{ messageId: number; text: string }>;
}

function fakeBot(): FakeBot {
  const handlers = new Map<string, (ctx: unknown) => Promise<void> | void>();
  const sent: Array<{ chatId: number; text: string }> = [];
  const edits: Array<{ messageId: number; text: string }> = [];
  let msgId = 100;
  const api = {
    sendMessage: async (chatId: number, text: string) => {
      sent.push({ chatId, text });
      return { message_id: ++msgId };
    },
    editMessageText: async (_chatId: number, messageId: number, text: string) => {
      edits.push({ messageId, text });
    },
    setMyCommands: async () => {},
  };
  const bot = {
    use: () => {},
    command: () => {},
    callbackQuery: () => {},
    on: (event: string, fn: (ctx: unknown) => Promise<void> | void) => {
      handlers.set(event, fn);
    },
    catch: () => {},
    api,
    start: async () => {},
    stop: async () => {},
  };
  return { bot, handlers, sent, edits };
}

function makeAdapter(
  fb: FakeBot,
  overrides: Partial<TelegramOptions> = {},
): ReturnType<typeof createTelegram> {
  const opts = {
    token: 'test-token',
    allowedUserIds: [1],
    log: silentLogger(),
    orchestrator: {} as unknown,
    llm: {} as unknown,
    tools: { list: () => [] } as unknown,
    db: {} as unknown,
    followups: {} as unknown,
    botFactory: () => fb.bot as never,
    ...overrides,
  } as unknown as TelegramOptions;
  return createTelegram(opts);
}

const handler: ToolHandler = {
  name: 'codex_handoff',
  description: 'escalate',
  parameters: {},
  tier: 'confirm',
  confirmPrompt: (args) => `Spend a Codex call on: ${String(args['task'])}?`,
  invoke: async () => '',
};

function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

async function pressButton(fb: FakeBot, data: string, chatId = 5): Promise<void> {
  const cb = fb.handlers.get('callback_query:data');
  assert.ok(cb, 'callback_query:data handler should be registered');
  await cb({
    chat: { id: chatId },
    from: { id: 1 },
    callbackQuery: { data },
    answerCallbackQuery: async () => {},
  });
}

test('confirmToolCall resolves true when the user taps Yes', async () => {
  const fb = fakeBot();
  const adapter = makeAdapter(fb);
  const ctx: ToolContext = { chatId: 5, log: silentLogger() };
  const p = adapter.confirmToolCall(handler, { task: 'refactor X' }, ctx);
  await tick();
  assert.equal(fb.sent.length, 1);
  assert.match(fb.sent[0]!.text, /Spend a Codex call on: refactor X\?/);
  await pressButton(fb, 'confirm:1:yes');
  assert.equal(await p, true);
});

test('confirmToolCall resolves false when the user taps No', async () => {
  const fb = fakeBot();
  const adapter = makeAdapter(fb);
  const ctx: ToolContext = { chatId: 5, log: silentLogger() };
  const p = adapter.confirmToolCall(handler, { task: 'do thing' }, ctx);
  await tick();
  await pressButton(fb, 'confirm:1:no');
  assert.equal(await p, false);
});

test('confirmToolCall fails closed when there is no chat to ask in', async () => {
  const fb = fakeBot();
  const adapter = makeAdapter(fb);
  const ctx: ToolContext = { log: silentLogger() }; // no chatId
  assert.equal(await adapter.confirmToolCall(handler, { task: 'x' }, ctx), false);
  assert.equal(fb.sent.length, 0, 'no prompt should be sent');
});

test('confirmToolCall fails closed when the turn is already aborted', async () => {
  const fb = fakeBot();
  const adapter = makeAdapter(fb);
  const ctl = new AbortController();
  ctl.abort();
  const ctx: ToolContext = { chatId: 5, log: silentLogger(), signal: ctl.signal };
  assert.equal(await adapter.confirmToolCall(handler, { task: 'x' }, ctx), false);
  assert.equal(fb.sent.length, 0);
});

test('aborting the turn (/stop) while waiting resolves false', async () => {
  const fb = fakeBot();
  const adapter = makeAdapter(fb);
  const ctl = new AbortController();
  const ctx: ToolContext = { chatId: 5, log: silentLogger(), signal: ctl.signal };
  const p = adapter.confirmToolCall(handler, { task: 'x' }, ctx);
  await tick();
  assert.equal(fb.sent.length, 1);
  ctl.abort();
  assert.equal(await p, false);
});

test('a confirm press from a different chat cannot approve another chat’s prompt', async () => {
  const fb = fakeBot();
  const adapter = makeAdapter(fb);
  const ctx: ToolContext = { chatId: 5, log: silentLogger() };
  const p = adapter.confirmToolCall(handler, { task: 'rm -rf' }, ctx);
  await tick();
  // Press from chat 6 — must be rejected (different chat than the prompt).
  await pressButton(fb, 'confirm:1:yes', 6);
  const state = await Promise.race([p.then(() => 'settled'), tick().then(() => 'pending')]);
  assert.equal(state, 'pending', 'cross-chat press must not resolve the confirm');
  // The legitimate chat can still approve.
  await pressButton(fb, 'confirm:1:yes', 5);
  assert.equal(await p, true);
});

test('a stale button press (unknown id) is ignored without throwing', async () => {
  const fb = fakeBot();
  const adapter = makeAdapter(fb);
  const ctx: ToolContext = { chatId: 5, log: silentLogger() };
  const p = adapter.confirmToolCall(handler, { task: 'keep' }, ctx);
  await tick();
  await pressButton(fb, 'confirm:999:yes'); // wrong id — should be a no-op
  await pressButton(fb, 'confirm:1:yes'); // correct id
  assert.equal(await p, true);
});

test('intercept replies trigger afterReply hooks for instant responses', async () => {
  const fb = fakeBot();
  const afterReplies: string[] = [];
  let orchestratorCalls = 0;
  makeAdapter(fb, {
    orchestrator: {
      handleUserMessage: async () => {
        orchestratorCalls += 1;
      },
    } as unknown as TelegramOptions['orchestrator'],
    extensionIntercepts: () => [
      {
        extension: 'modulus-instant-responses',
        handler: async (ctx) => {
          await ctx.reply('Hey.');
        },
      },
    ],
    extensionAfterReplies: () => [
      {
        extension: 'modulus-voice',
        handler: async (ctx) => {
          afterReplies.push(ctx.text);
        },
      },
    ],
  });

  const textHandler = fb.handlers.get('message:text');
  assert.ok(textHandler, 'message:text handler should be registered');
  const replies: string[] = [];
  await textHandler({
    chat: { id: 5 },
    from: { id: 1 },
    message: { text: 'hi' },
    reply: async (text: string) => {
      replies.push(text);
    },
  });
  await tick();

  assert.deepEqual(replies, ['Hey.']);
  assert.deepEqual(afterReplies, ['Hey.']);
  assert.equal(orchestratorCalls, 0);
});

test('voice transcripts use the same instant-response intercept path as text', async () => {
  const fb = fakeBot();
  const afterReplies: string[] = [];
  let orchestratorCalls = 0;
  makeAdapter(fb, {
    orchestrator: {
      handleUserMessage: async () => {
        orchestratorCalls += 1;
      },
    } as unknown as TelegramOptions['orchestrator'],
    extensionVoiceMessages: () => [
      {
        extension: 'modulus-voice',
        handler: async () => ({ transcript: 'hi' }),
      },
    ],
    extensionIntercepts: () => [
      {
        extension: 'modulus-instant-responses',
        handler: async (ctx) => {
          assert.equal(ctx.text, 'hi');
          await ctx.reply('Hey.');
        },
      },
    ],
    extensionAfterReplies: () => [
      {
        extension: 'modulus-voice',
        handler: async (ctx) => {
          afterReplies.push(ctx.text);
        },
      },
    ],
  });

  const voiceHandler = fb.handlers.get('message:voice');
  assert.ok(voiceHandler, 'message:voice handler should be registered');
  const replies: string[] = [];
  await voiceHandler({
    chat: { id: 5 },
    from: { id: 1 },
    message: {
      voice: {
        file_id: 'voice-file',
        duration: 1,
        mime_type: 'audio/ogg',
      },
    },
    reply: async (text: string) => {
      replies.push(text);
    },
  });
  await tick();

  assert.deepEqual(replies, ['Hey.']);
  assert.deepEqual(afterReplies, ['Hey.']);
  assert.equal(orchestratorCalls, 0);
});
