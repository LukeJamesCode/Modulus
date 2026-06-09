import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRoutedLLM } from './llm-router.js';
import { LLMTimeoutError } from './llm.js';
import type { ChatChunk, ChatOptions, LLM, LLMProvider } from './llm.js';

// Minimal base LLM. The router only touches the base for non-provider models
// and for the delegated health/profile methods; the provider-timeout path under
// test never calls into it.
function fakeBase(overrides: Partial<LLM> = {}): LLM {
  return {
    chat: () => {
      throw new Error('base.chat should not be called for a routed model');
    },
    health: async () => ({ ok: true, models: [] }),
    listProfiles: () => ({ chat: null, reason: null, tools: null }),
    resolveModel: (p) => (typeof p === 'object' ? p.model : 'base-model'),
    breakerSnapshot: () => ({
      state: 'closed',
      failures: 0,
      consecutiveSuccesses: 0,
      openedAt: null,
      retryAt: null,
    }),
    stopIdleEviction: () => {},
    ...overrides,
  };
}

async function collect(stream: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const c of stream) out.push(c);
  return out;
}

// A provider that never produces a chunk until its signal aborts, then rejects
// like a real fetch-backed provider would. Lets us prove the router's own cap
// fires even when the provider ignores the clock itself.
const hangingProvider: LLMProvider = {
  id: 'slow',
  async *chat(o) {
    await new Promise<void>((_, reject) => {
      o.signal?.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
    yield { delta: '', done: true };
  },
};

test('routed provider that hangs past the cap surfaces LLMTimeoutError', async () => {
  const llm = createRoutedLLM(fakeBase(), { providerTimeoutMs: 20 });
  llm.registerProvider(hangingProvider);
  await assert.rejects(
    collect(llm.chat({ profile: { model: 'slow:x' }, messages: [] })),
    (e) => e instanceof LLMTimeoutError,
  );
});

test('a caller /stop on a routed provider surfaces the abort, not a timeout', async () => {
  // The cap is generous; the caller cancels first. The router must NOT relabel a
  // user-initiated /stop as an inference timeout — the orchestrator treats the
  // two differently (clean cancel vs. fail loud).
  const llm = createRoutedLLM(fakeBase(), { providerTimeoutMs: 5_000 });
  llm.registerProvider(hangingProvider);
  const ctl = new AbortController();
  const p = collect(llm.chat({ profile: { model: 'slow:x' }, messages: [], signal: ctl.signal }));
  ctl.abort();
  await assert.rejects(p, (e) => e instanceof Error && e.name === 'AbortError');
});

test('a fast routed provider streams through untouched', async () => {
  const fast: LLMProvider = {
    id: 'fast',
    async *chat() {
      yield { delta: 'hi', done: false };
      yield { delta: '', done: true, model: 'fast:m' };
    },
  };
  const llm = createRoutedLLM(fakeBase(), { providerTimeoutMs: 50 });
  llm.registerProvider(fast);
  const chunks = await collect(llm.chat({ profile: { model: 'fast:m' }, messages: [] }));
  assert.deepEqual(
    chunks.map((c) => c.delta),
    ['hi', ''],
  );
});

test('a non-provider model delegates to the base (no timeout wrapper)', async () => {
  let baseCalled: ChatOptions | null = null;
  const base = fakeBase({
    chat: (o) => {
      baseCalled = o;
      return (async function* () {
        yield { delta: 'from base', done: true };
      })();
    },
  });
  const llm = createRoutedLLM(base, { providerTimeoutMs: 20 });
  llm.registerProvider(hangingProvider);
  const chunks = await collect(llm.chat({ profile: 'chat', messages: [] }));
  assert.equal(baseCalled !== null, true);
  assert.equal(chunks[0]!.delta, 'from base');
});
