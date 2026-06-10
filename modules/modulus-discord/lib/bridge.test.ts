import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  createBridge,
  createRateLimiter,
  splitForDiscord,
  stripBotMention,
  DISCORD_MESSAGE_MAX,
  type OutboundTransport,
} from './bridge.js';
import type { InboundMessage } from '../../../src/core/chat-dispatch.js';

const SILENT_LOG = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => SILENT_LOG,
};

function fakeIdentity() {
  let seq = -8_000_000_000_002;
  const seen = new Map<string, number>();
  return {
    chatIdFor(opts: { userId: string; channelId: string; isDm: boolean }): number {
      const key = `${opts.userId}:${opts.channelId}`;
      const existing = seen.get(key);
      if (existing !== undefined) return existing;
      const id = seq--;
      seen.set(key, id);
      return id;
    },
    resolve: () => null,
    count: () => seen.size,
  };
}

interface CapturedSend {
  channelId: string;
  text: string;
}

function fakeTransport(): OutboundTransport & { sent: CapturedSend[] } {
  const sent: CapturedSend[] = [];
  return {
    sent,
    send: async (channelId, text) => {
      sent.push({ channelId, text });
    },
    startTyping: async () => {},
  };
}

// A stand-in for host.chat.dispatchInbound. Records every inbound turn and, when
// given reply content, drives the surface `reply` callback the way the real
// shared pipeline does on a finished turn.
function fakeDispatch(replyWith?: string | string[]) {
  const calls: InboundMessage[] = [];
  const fn = async (msg: InboundMessage): Promise<void> => {
    calls.push(msg);
    if (replyWith === undefined) return;
    const parts = Array.isArray(replyWith) ? replyWith : [replyWith];
    for (const p of parts) await msg.reply(p);
  };
  return { calls, fn };
}

test('stripBotMention: removes <@id> and <@!id> forms', () => {
  assert.equal(stripBotMention('<@123> hello', '123'), 'hello');
  assert.equal(stripBotMention('<@!123> hi there', '123'), 'hi there');
  assert.equal(stripBotMention('hey <@123>, do X', '123'), 'hey , do X');
  assert.equal(
    stripBotMention('<@999> ignore other mention', '123'),
    '<@999> ignore other mention',
  );
});

test('splitForDiscord: passes short messages through unchanged', () => {
  assert.deepEqual(splitForDiscord('short'), ['short']);
});

test('splitForDiscord: breaks long messages on paragraph boundaries when possible', () => {
  const para = 'a'.repeat(500);
  const text = `${para}\n\n${para}\n\n${para}\n\n${para}\n\n${para}`;
  const parts = splitForDiscord(text, 1100);
  for (const p of parts) assert.ok(p.length <= 1100, `part too long: ${p.length}`);
  // Joined content (whitespace-normalised) is preserved.
  const original = text.replace(/\s+/g, '');
  const joined = parts.join('').replace(/\s+/g, '');
  assert.equal(joined, original);
});

test('splitForDiscord: handles messages with no break points by hard-slicing', () => {
  const text = 'x'.repeat(DISCORD_MESSAGE_MAX * 2 + 17);
  const parts = splitForDiscord(text);
  for (const p of parts) assert.ok(p.length <= DISCORD_MESSAGE_MAX);
  assert.equal(parts.join(''), text);
});

test('bridge: empty mention replies without invoking the pipeline', async () => {
  const dispatch = fakeDispatch();
  const transport = fakeTransport();
  const bridge = createBridge({
    dispatch: dispatch.fn,
    identity: fakeIdentity(),
    transport,
    rateLimiter: createRateLimiter(0),
    log: SILENT_LOG,
    botUserId: 'bot-1',
  });

  await bridge.handle({ userId: 'u-1', channelId: 'c-1', guildId: 'g-1', rawContent: '<@bot-1>' });

  assert.equal(dispatch.calls.length, 0);
  assert.equal(transport.sent.length, 1);
  assert.match(transport.sent[0]!.text, /send a message/i);
});

test('bridge: rate-limited turn returns a friendly nudge and does not dispatch', async () => {
  const dispatch = fakeDispatch('ok');
  const transport = fakeTransport();
  const bridge = createBridge({
    dispatch: dispatch.fn,
    identity: fakeIdentity(),
    transport,
    rateLimiter: createRateLimiter(1), // budget of 1/minute
    log: SILENT_LOG,
    botUserId: 'bot-1',
  });

  await bridge.handle({
    userId: 'u-1',
    channelId: 'c-1',
    guildId: 'g-1',
    rawContent: '<@bot-1> first',
  });
  await bridge.handle({
    userId: 'u-1',
    channelId: 'c-1',
    guildId: 'g-1',
    rawContent: '<@bot-1> second',
  });

  assert.equal(dispatch.calls.length, 1);
  const last = transport.sent.at(-1)!;
  assert.match(last.text, /per-minute limit/i);
});

test('bridge: forwards stripped text to the pipeline and renders the reply', async () => {
  const dispatch = fakeDispatch('Hello, world!');
  const transport = fakeTransport();
  const bridge = createBridge({
    dispatch: dispatch.fn,
    identity: fakeIdentity(),
    transport,
    rateLimiter: createRateLimiter(0),
    log: SILENT_LOG,
    botUserId: 'bot-1',
  });

  await bridge.handle({ userId: 'u-1', channelId: 'c-1', guildId: null, rawContent: 'hi there' });

  assert.equal(dispatch.calls.length, 1);
  assert.equal(dispatch.calls[0]!.text, 'hi there');
  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0]!.text, 'Hello, world!');
});

test('bridge: a long reply is split across multiple sends under the char cap', async () => {
  const long = 'y'.repeat(DISCORD_MESSAGE_MAX + 500);
  const dispatch = fakeDispatch(long);
  const transport = fakeTransport();
  const bridge = createBridge({
    dispatch: dispatch.fn,
    identity: fakeIdentity(),
    transport,
    rateLimiter: createRateLimiter(0),
    log: SILENT_LOG,
    botUserId: 'bot-1',
  });

  await bridge.handle({ userId: 'u-1', channelId: 'c-1', guildId: null, rawContent: 'hi' });

  assert.ok(transport.sent.length >= 2, 'long reply should split');
  for (const s of transport.sent) assert.ok(s.text.length <= DISCORD_MESSAGE_MAX);
});

test('bridge: identity assigns a stable chatId per (user, channel)', async () => {
  const dispatch = fakeDispatch('ok');
  const transport = fakeTransport();
  const bridge = createBridge({
    dispatch: dispatch.fn,
    identity: fakeIdentity(),
    transport,
    rateLimiter: createRateLimiter(0),
    log: SILENT_LOG,
    botUserId: 'bot-1',
  });

  for (let i = 0; i < 3; i++) {
    await bridge.handle({ userId: 'u-1', channelId: 'c-1', guildId: null, rawContent: 'hi' });
  }
  const ids = new Set(dispatch.calls.map((c) => c.chatId));
  assert.equal(ids.size, 1, 'same pair must collapse to one chatId');
});

test('bridge: shared identity maps a DM onto the configured Telegram chat id', async () => {
  const dispatch = fakeDispatch('ok');
  const transport = fakeTransport();
  const bridge = createBridge({
    dispatch: dispatch.fn,
    identity: fakeIdentity(),
    transport,
    rateLimiter: createRateLimiter(0),
    log: SILENT_LOG,
    botUserId: 'bot-1',
    sharedTelegramChatId: () => 42,
  });

  // DM shares the Telegram thread…
  await bridge.handle({ userId: 'u-1', channelId: 'c-1', guildId: null, rawContent: 'hi' });
  assert.equal(dispatch.calls.at(-1)!.chatId, 42);

  // …but a guild channel stays on its own synthetic (negative) id.
  await bridge.handle({
    userId: 'u-1',
    channelId: 'c-2',
    guildId: 'g-1',
    rawContent: '<@bot-1> yo',
  });
  assert.ok(dispatch.calls.at(-1)!.chatId < 0, 'guild channel must not use the shared id');
});
