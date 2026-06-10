import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createConfirmRenderer, type ConfirmTransport } from './confirm.js';
import type { ChatConfirmRequest, ChatConfirmHandler } from '../../../src/core/modules.js';
import { DISCORD_CHAT_ID_BASE, type DiscordChatRow } from './identity.js';

const SILENT_LOG = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => SILENT_LOG,
};

function fakeChat(chatId: number): DiscordChatRow {
  return {
    modulusChatId: chatId,
    discordUserId: '111',
    discordChannelId: 'chan-1',
    isDm: true,
    firstSeenAt: 0,
    lastSeenAt: 0,
  };
}

interface SendCall {
  channelId: string;
  text: string;
  yesId: string;
  noId: string;
}

interface FakeTransport extends ConfirmTransport {
  sent: SendCall[];
  edits: Array<{ messageId: string; text: string }>;
  // Drive sendPrompt completion manually so we can test ordering races.
  resolveLastSend: (msgId?: string) => void;
}

function makeTransport(chats: Map<number, DiscordChatRow>): FakeTransport {
  const sent: SendCall[] = [];
  const edits: Array<{ messageId: string; text: string }> = [];
  const pendingResolves: Array<(value: { channelId: string; messageId: string }) => void> = [];
  let msgSeq = 0;
  return {
    sent,
    edits,
    resolveLastSend(msgId?: string): void {
      const resolve = pendingResolves.shift();
      if (resolve) {
        resolve({ channelId: 'chan-1', messageId: msgId ?? `m-${++msgSeq}` });
      }
    },
    resolveChat: (chatId) => chats.get(chatId) ?? null,
    sendPrompt: ({ channelId, text, yesCustomId, noCustomId }) => {
      sent.push({ channelId, text, yesId: yesCustomId, noId: noCustomId });
      return new Promise((resolve) => {
        pendingResolves.push(resolve);
      });
    },
    editPrompt: async (ref, text) => {
      edits.push({ messageId: ref.messageId, text });
    },
  };
}

function buildRequest(chatId: number, signal?: AbortSignal): ChatConfirmRequest {
  const req: ChatConfirmRequest = {
    chatId,
    toolName: 'fake_tool',
    preview: 'Run fake_tool?',
  };
  if (signal) req.signal = signal;
  return req;
}

test('confirm: yes-button resolves true and edits the prompt', async () => {
  const chatId = DISCORD_CHAT_ID_BASE - 1;
  const chats = new Map([[chatId, fakeChat(chatId)]]);
  const transport = makeTransport(chats);
  const renderer = createConfirmRenderer({ transport, log: SILENT_LOG });
  const promise = renderer.handle(buildRequest(chatId));

  // Allow microtasks to run so sendPrompt is invoked.
  await Promise.resolve();
  transport.resolveLastSend('m-1');
  await Promise.resolve();

  const sent = transport.sent[0]!;
  const claimed = renderer.onButton(sent.yesId, { userId: '111' });
  assert.equal(claimed, true);

  const result = await promise;
  assert.equal(result, true);
  // The post-resolve edit drops the buttons and replaces with the approval note.
  assert.ok(transport.edits.some((e) => e.text.includes('Approved')));
});

test('confirm: no-button resolves false and notes decline', async () => {
  const chatId = DISCORD_CHAT_ID_BASE - 2;
  const transport = makeTransport(new Map([[chatId, fakeChat(chatId)]]));
  const renderer = createConfirmRenderer({ transport, log: SILENT_LOG });
  const promise = renderer.handle(buildRequest(chatId));
  await Promise.resolve();
  transport.resolveLastSend();
  await Promise.resolve();

  const sent = transport.sent[0]!;
  renderer.onButton(sent.noId, { userId: '111' });

  assert.equal(await promise, false);
  assert.ok(transport.edits.some((e) => e.text.includes('Declined')));
});

test('confirm: second click on a resolved token is ignored (single-use)', async () => {
  const chatId = DISCORD_CHAT_ID_BASE - 3;
  const transport = makeTransport(new Map([[chatId, fakeChat(chatId)]]));
  const renderer = createConfirmRenderer({ transport, log: SILENT_LOG });
  const promise = renderer.handle(buildRequest(chatId));
  await Promise.resolve();
  transport.resolveLastSend();
  await Promise.resolve();

  const sent = transport.sent[0]!;
  // First click resolves the promise.
  renderer.onButton(sent.yesId, { userId: '111' });
  assert.equal(await promise, true);
  // Pending map is now empty.
  assert.equal(renderer.pendingCount(), 0);

  // Second click on the SAME token (either button) is still claimed by the
  // dispatcher (so Discord can ack it) but has no effect on any promise.
  const claimed = renderer.onButton(sent.noId, { userId: '111' });
  assert.equal(claimed, true);
});

test('confirm: timeout fires after the configured budget and fails closed', async () => {
  const chatId = DISCORD_CHAT_ID_BASE - 4;
  const transport = makeTransport(new Map([[chatId, fakeChat(chatId)]]));
  const renderer = createConfirmRenderer({
    transport,
    log: SILENT_LOG,
    // 10ms keeps the test fast; the production default is 60s.
    timeoutMs: 10,
  });
  const promise = renderer.handle(buildRequest(chatId));
  await Promise.resolve();
  transport.resolveLastSend();

  // The production timeout timer is unref'd so a forgotten confirm can't block
  // process shutdown. That means it's the only handle this test would leave on
  // the loop — run in isolation, Node drains the loop before the 10ms timer
  // fires and the awaited promise never settles. A ref'd guard keeps the loop
  // alive across the timeout window; we clear it once the promise settles.
  const guard = setTimeout(() => {}, 1000);
  const result = await promise;
  clearTimeout(guard);
  assert.equal(result, false);
  // The prompt was edited to reflect the timeout state.
  assert.ok(transport.edits.some((e) => e.text.includes('Timed out')));
});

test('confirm: abort signal cancels a pending confirm', async () => {
  const chatId = DISCORD_CHAT_ID_BASE - 5;
  const transport = makeTransport(new Map([[chatId, fakeChat(chatId)]]));
  const renderer = createConfirmRenderer({ transport, log: SILENT_LOG });
  const ac = new AbortController();
  const promise = renderer.handle(buildRequest(chatId, ac.signal));
  await Promise.resolve();
  transport.resolveLastSend();
  await Promise.resolve();

  ac.abort();
  const result = await promise;
  assert.equal(result, false);
  assert.ok(transport.edits.some((e) => e.text.includes('Cancelled')));
});

test('confirm: unknown chatId fails closed without sending a prompt', async () => {
  const transport = makeTransport(new Map());
  const renderer = createConfirmRenderer({ transport, log: SILENT_LOG });
  const result = await renderer.handle(buildRequest(DISCORD_CHAT_ID_BASE - 999));
  assert.equal(result, false);
  assert.equal(transport.sent.length, 0);
});

test('confirm: send failure fails closed', async () => {
  const chatId = DISCORD_CHAT_ID_BASE - 6;
  const transport: ConfirmTransport = {
    resolveChat: () => fakeChat(chatId),
    sendPrompt: async () => {
      throw new Error('discord 403');
    },
    editPrompt: async () => {},
  };
  const renderer = createConfirmRenderer({ transport, log: SILENT_LOG });
  const result = await renderer.handle(buildRequest(chatId));
  assert.equal(result, false);
});

test('confirm: handle is structurally a ChatConfirmHandler', () => {
  // Type-only assertion: the renderer's handle field must satisfy the
  // surface contract Core registers against.
  const transport = makeTransport(new Map());
  const renderer = createConfirmRenderer({ transport, log: SILENT_LOG });
  const _handler: ChatConfirmHandler = renderer.handle;
  void _handler;
});
