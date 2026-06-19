// Memory-extraction tests. What matters (and why):
// - The job writes durable facts to the store with source 'extraction', so later
//   turns recall them — but only the store write is asserted, never the model.
// - It must be cheap and safe on the detached reply path: the gate and the
//   skip-rules avoid a model call, and malformed output must never throw.
// - It relies on the store for dedup, adding none of its own.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open as openDb } from '../storage/db.js';
import { setupMemory } from './memory.js';
import { createMemoryExtractor } from './memory-extraction.js';
import { createLogger } from '../util/log.js';
import type { LLM, ChatChunk, ChatOptions } from './llm.js';
import type { AfterTurnContext } from './modules.js';

const log = createLogger({ level: 'error', out: () => {}, err: () => {} });

function fakeLlm(reply: string): LLM & { calls: ChatOptions[] } {
  const calls: ChatOptions[] = [];
  async function* one(): AsyncIterable<ChatChunk> {
    yield { delta: reply, done: true, model: 'fake' };
  }
  const llm: LLM = {
    chat(opts) {
      calls.push(opts);
      return one();
    },
    async health() {
      return { ok: true, models: ['fake'] };
    },
    listProfiles() {
      return {
        chat: { model: 'fake', contextTokens: 4096, heavy: false },
        reason: null,
        tools: null,
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

function freshStore(): { store: ReturnType<typeof setupMemory>; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'modulus-extract-'));
  const db = openDb({ path: join(dir, 'm.db'), log });
  const store = setupMemory({ db, log });
  return {
    store,
    cleanup: () => {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function turn(userText: string): AfterTurnContext {
  return {
    chatId: 1,
    userId: 1,
    conversationId: 1,
    userText,
    assistantText: 'sure',
    startedAt: 0,
    finishedAt: 1,
    toolCalls: [],
  };
}

test('a turn with a durable fact stores one extraction row', async () => {
  const { store, cleanup } = freshStore();
  try {
    const llm = fakeLlm('["User\'s sister Mia lives in Lisbon."]');
    const extract = createMemoryExtractor({ llm, memory: store, log, enabled: true });
    await extract(turn('my sister Mia just moved to Lisbon'));
    assert.equal(llm.calls.length, 1);
    assert.equal(store.count(), 1);
    const row = store.list()[0]!;
    assert.equal(row.source, 'extraction');
    assert.equal(row.agentId, null, 'extraction is global hive-mind truth');
    assert.match(row.content, /Mia/);
  } finally {
    cleanup();
  }
});

test('an empty extraction writes nothing', async () => {
  const { store, cleanup } = freshStore();
  try {
    const llm = fakeLlm('[]');
    const extract = createMemoryExtractor({ llm, memory: store, log, enabled: true });
    await extract(turn('what is the weather like today'));
    assert.equal(llm.calls.length, 1);
    assert.equal(store.count(), 0);
  } finally {
    cleanup();
  }
});

test('malformed model output never throws and writes nothing', async () => {
  const { store, cleanup } = freshStore();
  try {
    const llm = fakeLlm('Sure! Here are the facts I found for you.');
    const extract = createMemoryExtractor({ llm, memory: store, log, enabled: true });
    await assert.doesNotReject(() => extract(turn('tell me something about my life')));
    assert.equal(store.count(), 0);
  } finally {
    cleanup();
  }
});

test('the same fact extracted twice stays one row (store dedup, none of its own)', async () => {
  const { store, cleanup } = freshStore();
  try {
    const llm = fakeLlm('["User prefers tea over coffee."]');
    const extract = createMemoryExtractor({ llm, memory: store, log, enabled: true });
    await extract(turn('I really prefer tea over coffee these days'));
    await extract(turn('just so you know, tea over coffee for me'));
    assert.equal(store.count(), 1, "dedup is the store's job; the extractor adds none");
  } finally {
    cleanup();
  }
});

test('disabled gate makes no model call at all', async () => {
  const { store, cleanup } = freshStore();
  try {
    const llm = fakeLlm('["should never run"]');
    const extract = createMemoryExtractor({ llm, memory: store, log, enabled: false });
    await extract(turn('my favourite colour is teal and always has been'));
    assert.equal(llm.calls.length, 0, 'gate must short-circuit before any model call');
    assert.equal(store.count(), 0);
  } finally {
    cleanup();
  }
});

test('cheap turns (slash-commands, too-short) skip the model', async () => {
  const { store, cleanup } = freshStore();
  try {
    const llm = fakeLlm('["nope"]');
    const extract = createMemoryExtractor({ llm, memory: store, log, enabled: true });
    await extract(turn('/status'));
    await extract(turn('thanks'));
    await extract(turn('ok do it'));
    assert.equal(llm.calls.length, 0, 'slash-commands and sub-4-word turns never reach the model');
    assert.equal(store.count(), 0);
  } finally {
    cleanup();
  }
});
