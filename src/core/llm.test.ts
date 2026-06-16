import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createOllama, CircuitOpenError, LLMHttpError, type ChatChunk } from './llm.js';
import { createLogger } from '../util/log.js';

function silentLogger() {
  return createLogger({ level: 'error', out: () => {}, err: () => {} });
}

function streamingResponse(lines: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      for (const l of lines) c.enqueue(enc.encode(l + '\n'));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
}

async function collect(it: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

// Mirror the orchestrator's drain loop, which breaks out of the iterator as
// soon as it sees the done chunk instead of running it to EOF. Consuming the
// stream this way is what exposed the breaker bug where recordSuccess() never
// ran on the real pipeline.
async function drainBreakingOnDone(it: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const c of it) {
    out.push(c);
    if (c.done) break;
  }
  return out;
}

test('chat() streams ndjson chunks and records prompt/completion tokens', async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return streamingResponse([
      JSON.stringify({ model: 'qwen3.5:0.8b', message: { content: 'Hello ' }, done: false }),
      JSON.stringify({ model: 'qwen3.5:0.8b', message: { content: 'world.' }, done: false }),
      JSON.stringify({
        model: 'qwen3.5:0.8b',
        message: { content: '' },
        done: true,
        prompt_eval_count: 10,
        eval_count: 4,
      }),
    ]);
  };
  const llm = createOllama({
    baseUrl: 'http://x',
    log: silentLogger(),
    fetchImpl: fetchImpl as unknown as typeof fetch,
    profiles: {
      chat: { model: 'qwen3.5:0.8b', contextTokens: 4096, heavy: false },
    },
  });
  const chunks = await collect(
    llm.chat({ profile: 'chat', messages: [{ role: 'user', content: 'hi' }] }),
  );
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0]!.delta, 'Hello ');
  assert.equal(chunks[2]!.done, true);
  assert.equal(chunks[2]!.promptTokens, 10);
  assert.equal(chunks[2]!.completionTokens, 4);
  // One /api/chat call. (A capability probe to /api/show may also be issued;
  // filter to the inference call so this stays robust to that.)
  const chatCalls = calls.filter((c) => c.url.endsWith('/api/chat'));
  assert.equal(chatCalls.length, 1);
  llm.stopIdleEviction();
});

test('updateModels() re-points an existing profile so the next turn uses the new tag', async () => {
  const chatModels: string[] = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { model?: string };
    if (String(url).endsWith('/api/chat')) chatModels.push(body.model!);
    return streamingResponse([
      JSON.stringify({ model: body.model, message: { content: 'ok' }, done: true }),
    ]);
  };
  const llm = createOllama({
    baseUrl: 'http://x',
    log: silentLogger(),
    fetchImpl: fetchImpl as unknown as typeof fetch,
    profiles: { chat: { model: 'old:1b', contextTokens: 4096, heavy: false } },
  });

  await collect(llm.chat({ profile: 'chat', messages: [{ role: 'user', content: 'hi' }] }));
  assert.equal(llm.resolveModel('chat'), 'old:1b');

  llm.updateModels!({ chat: 'new:7b' });
  assert.equal(llm.resolveModel('chat'), 'new:7b');

  await collect(llm.chat({ profile: 'chat', messages: [{ role: 'user', content: 'hi' }] }));
  assert.deepEqual(chatModels, ['old:1b', 'new:7b']);

  // A slot the host never configured is left absent — adding one needs a restart.
  llm.updateModels!({ chat: 'new:7b', tools: 'tools:7b' });
  assert.equal(llm.listProfiles().tools, null);
  llm.stopIdleEviction();
});

test('chat() forwards message images to Ollama for a multimodal turn', async () => {
  const calls: Array<{ url: string; body: { messages?: Array<{ images?: string[] }> } }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return streamingResponse([
      JSON.stringify({ model: 'm', message: { content: 'ok' }, done: true }),
    ]);
  };
  const llm = createOllama({
    baseUrl: 'http://x',
    log: silentLogger(),
    fetchImpl: fetchImpl as unknown as typeof fetch,
    profiles: { chat: { model: 'm', contextTokens: 1024, heavy: false } },
  });
  await collect(
    llm.chat({
      profile: 'chat',
      messages: [{ role: 'user', content: 'what is this?', images: ['BASE64DATA'] }],
    }),
  );
  const chat = calls.find((c) => c.url.endsWith('/api/chat'))!;
  // Images ride the user message verbatim; a text-only message has no images key.
  assert.deepEqual(chat.body.messages?.[0]?.images, ['BASE64DATA']);
  llm.stopIdleEviction();
});

test('supportsVision reads the /api/show vision capability', async () => {
  const fetchImpl = async (url: string | URL | Request) => {
    if (String(url).endsWith('/api/show')) {
      return new Response(JSON.stringify({ capabilities: ['completion', 'vision'] }), {
        status: 200,
      });
    }
    return new Response('{}', { status: 200 });
  };
  const llm = createOllama({
    baseUrl: 'http://x',
    log: silentLogger(),
    fetchImpl: fetchImpl as unknown as typeof fetch,
    profiles: { chat: { model: 'gemma4:12b', contextTokens: 1024, heavy: false } },
  });
  assert.equal(await llm.supportsVision!('gemma4:12b'), true);
  llm.stopIdleEviction();
});

test('supportsVision is false when the probe reports no vision capability', async () => {
  const fetchImpl = async (url: string | URL | Request) => {
    if (String(url).endsWith('/api/show')) {
      return new Response(JSON.stringify({ capabilities: ['completion'] }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  };
  const llm = createOllama({
    baseUrl: 'http://x',
    log: silentLogger(),
    fetchImpl: fetchImpl as unknown as typeof fetch,
    profiles: { chat: { model: 'qwen3.5:0.8b', contextTokens: 1024, heavy: false } },
  });
  // Probe is authoritative: even a qwen3 tag (family fallback 'yes') is 'no'
  // when Ollama says the actual pulled model has no vision capability.
  assert.equal(await llm.supportsVision!('qwen3.5:0.8b'), false);
  llm.stopIdleEviction();
});

test('chat() forwards tool_calls in the final chunk', async () => {
  const fetchImpl = async () =>
    streamingResponse([
      JSON.stringify({
        model: 'm',
        message: {
          tool_calls: [{ function: { name: 'add', arguments: { a: 1, b: 2 } } }],
        },
        done: true,
      }),
    ]);
  const llm = createOllama({
    baseUrl: 'http://x',
    log: silentLogger(),
    fetchImpl: fetchImpl as unknown as typeof fetch,
    profiles: { chat: { model: 'm', contextTokens: 1024, heavy: false } },
  });
  const chunks = await collect(llm.chat({ profile: 'chat', messages: [] }));
  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0]!.toolCalls?.[0]!.arguments, { a: 1, b: 2 });
  assert.equal(chunks[0]!.toolCalls?.[0]!.name, 'add');
  llm.stopIdleEviction();
});

test('circuit breaker trips after threshold failures and fails fast', async () => {
  let n = 0;
  const fetchImpl = async () => {
    n++;
    return new Response('boom', { status: 500 });
  };
  const llm = createOllama({
    baseUrl: 'http://x',
    log: silentLogger(),
    fetchImpl: fetchImpl as unknown as typeof fetch,
    profiles: { chat: { model: 'm', contextTokens: 1024, heavy: false } },
    failureThreshold: 2,
    cooldownMs: 60_000,
    now: () => 0,
  });
  for (let i = 0; i < 2; i++) {
    await assert.rejects(collect(llm.chat({ profile: 'chat', messages: [] })), LLMHttpError);
  }
  // Third call should fail fast without hitting fetch.
  const before = n;
  await assert.rejects(collect(llm.chat({ profile: 'chat', messages: [] })), CircuitOpenError);
  assert.equal(n, before);
  llm.stopIdleEviction();
});

test('records success when the consumer breaks on the done chunk (orchestrator drain)', async () => {
  let mode: 'fail' | 'ok' = 'fail';
  const fetchImpl = async () => {
    if (mode === 'fail') return new Response('boom', { status: 500 });
    return streamingResponse([
      JSON.stringify({ model: 'm', message: { content: 'ok' }, done: true }),
    ]);
  };
  const llm = createOllama({
    baseUrl: 'http://x',
    log: silentLogger(),
    fetchImpl: fetchImpl as unknown as typeof fetch,
    profiles: { chat: { model: 'm', contextTokens: 1024, heavy: false } },
    failureThreshold: 3,
    cooldownMs: 60_000,
    now: () => 0,
  });
  // One real failure leaves the breaker counting.
  await assert.rejects(collect(llm.chat({ profile: 'chat', messages: [] })), LLMHttpError);
  assert.equal(llm.breakerSnapshot().failures, 1);
  // A success consumed the way the orchestrator consumes it (break on the done
  // chunk) must still reset the failure counter. Before the fix, the early
  // break ran the generator's return() and skipped recordSuccess() entirely.
  mode = 'ok';
  await drainBreakingOnDone(llm.chat({ profile: 'chat', messages: [] }));
  assert.equal(llm.breakerSnapshot().failures, 0);
  llm.stopIdleEviction();
});

test('half-open breaker closes via the break-on-done consumer path', async () => {
  let mode: 'fail' | 'ok' = 'fail';
  const fetchImpl = async () => {
    if (mode === 'fail') return new Response('boom', { status: 500 });
    return streamingResponse([
      JSON.stringify({ model: 'm', message: { content: 'ok' }, done: true }),
    ]);
  };
  let nowVal = 0;
  const llm = createOllama({
    baseUrl: 'http://x',
    log: silentLogger(),
    fetchImpl: fetchImpl as unknown as typeof fetch,
    profiles: { chat: { model: 'm', contextTokens: 1024, heavy: false } },
    failureThreshold: 2,
    cooldownMs: 1000,
    halfOpenGrace: 2,
    now: () => nowVal,
  });
  await assert.rejects(collect(llm.chat({ profile: 'chat', messages: [] })), LLMHttpError);
  await assert.rejects(collect(llm.chat({ profile: 'chat', messages: [] })), LLMHttpError);
  assert.equal(llm.breakerSnapshot().state, 'open');
  // Cooldown elapses; both half-open probe successes are consumed with the
  // early-break loop, which previously never closed the breaker.
  nowVal = 2000;
  mode = 'ok';
  await drainBreakingOnDone(llm.chat({ profile: 'chat', messages: [] }));
  assert.equal(llm.breakerSnapshot().state, 'half-open');
  await drainBreakingOnDone(llm.chat({ profile: 'chat', messages: [] }));
  assert.equal(llm.breakerSnapshot().state, 'closed');
  llm.stopIdleEviction();
});

test('half-open requires `halfOpenGrace` consecutive successes before fully closing', async () => {
  // Sequence: 2 failures (trip), cooldown elapses, 1 success (still half-open),
  // 1 failure (re-opens immediately even though we haven't hit failureThreshold
  // again — half-open should be strict).
  let mode: 'fail' | 'ok' = 'fail';
  const fetchImpl = async () => {
    if (mode === 'fail') return new Response('boom', { status: 500 });
    return streamingResponse([
      JSON.stringify({ model: 'm', message: { content: 'ok' }, done: true }),
    ]);
  };
  let nowVal = 0;
  const llm = createOllama({
    baseUrl: 'http://x',
    log: silentLogger(),
    fetchImpl: fetchImpl as unknown as typeof fetch,
    profiles: { chat: { model: 'm', contextTokens: 1024, heavy: false } },
    failureThreshold: 2,
    cooldownMs: 1000,
    halfOpenGrace: 2,
    now: () => nowVal,
  });
  // Trip the breaker.
  await assert.rejects(collect(llm.chat({ profile: 'chat', messages: [] })), LLMHttpError);
  await assert.rejects(collect(llm.chat({ profile: 'chat', messages: [] })), LLMHttpError);
  assert.equal(llm.breakerSnapshot().state, 'open');
  // Cooldown elapses; first success enters half-open and counts 1.
  nowVal = 2000;
  mode = 'ok';
  await collect(llm.chat({ profile: 'chat', messages: [] }));
  assert.equal(llm.breakerSnapshot().state, 'half-open');
  assert.equal(llm.breakerSnapshot().consecutiveSuccesses, 1);
  // One more success closes the breaker.
  await collect(llm.chat({ profile: 'chat', messages: [] }));
  assert.equal(llm.breakerSnapshot().state, 'closed');
  llm.stopIdleEviction();
});

test('caller-aborted fetch does not count as a circuit-breaker failure', async () => {
  // /stop and shutdown abort the caller's signal; the resulting AbortError
  // would otherwise trip the breaker after a few cancels and lock the bot
  // out of its own LLM until the cooldown elapsed.
  const fetchImpl = async (_: string | URL | Request, init?: RequestInit) => {
    const sig = init?.signal;
    if (sig?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    return new Response('boom', { status: 500 });
  };
  const llm = createOllama({
    baseUrl: 'http://x',
    log: silentLogger(),
    fetchImpl: fetchImpl as unknown as typeof fetch,
    profiles: { chat: { model: 'm', contextTokens: 1024, heavy: false } },
    failureThreshold: 2,
    cooldownMs: 60_000,
    now: () => 0,
  });
  for (let i = 0; i < 5; i++) {
    const ctl = new AbortController();
    ctl.abort();
    await assert.rejects(
      collect(llm.chat({ profile: 'chat', messages: [], signal: ctl.signal })),
      /aborted/i,
    );
  }
  assert.equal(llm.breakerSnapshot().state, 'closed');
  assert.equal(llm.breakerSnapshot().failures, 0);
  llm.stopIdleEviction();
});

test('a failure during half-open immediately re-opens with a fresh cooldown', async () => {
  let mode: 'fail' | 'ok' = 'fail';
  const fetchImpl = async () => {
    if (mode === 'fail') return new Response('boom', { status: 500 });
    return streamingResponse([
      JSON.stringify({ model: 'm', message: { content: 'ok' }, done: true }),
    ]);
  };
  let nowVal = 0;
  const llm = createOllama({
    baseUrl: 'http://x',
    log: silentLogger(),
    fetchImpl: fetchImpl as unknown as typeof fetch,
    profiles: { chat: { model: 'm', contextTokens: 1024, heavy: false } },
    failureThreshold: 1,
    cooldownMs: 1000,
    halfOpenGrace: 2,
    now: () => nowVal,
  });
  await assert.rejects(collect(llm.chat({ profile: 'chat', messages: [] })), LLMHttpError);
  // Cooldown elapses → half-open.
  nowVal = 2000;
  mode = 'ok';
  await collect(llm.chat({ profile: 'chat', messages: [] }));
  assert.equal(llm.breakerSnapshot().state, 'half-open');
  // Now the next call fails again — should re-open with a fresh window.
  mode = 'fail';
  await assert.rejects(collect(llm.chat({ profile: 'chat', messages: [] })), LLMHttpError);
  const snap = llm.breakerSnapshot();
  assert.equal(snap.state, 'open');
  assert.equal(snap.openedAt, 2000);
  llm.stopIdleEviction();
});

test('heavy-model eviction unloads the previous heavy model before loading a new one', async () => {
  const calls: Array<{ url: string; body: { model: string; keep_alive?: number | string } }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      model: string;
      keep_alive?: number | string;
    };
    calls.push({ url: String(url), body });
    if (String(url).endsWith('/api/generate')) {
      return new Response('{}', { status: 200 });
    }
    return streamingResponse([
      JSON.stringify({ model: body.model, message: { content: 'ok' }, done: true }),
    ]);
  };
  const llm = createOllama({
    baseUrl: 'http://x',
    log: silentLogger(),
    fetchImpl: fetchImpl as unknown as typeof fetch,
    profiles: {
      chat: { model: 'qwen3.5:0.8b', contextTokens: 2048, heavy: true },
      reason: { model: 'qwen3.5:9b', contextTokens: 8192, heavy: true },
    },
  });
  await collect(llm.chat({ profile: 'chat', messages: [] }));
  await collect(llm.chat({ profile: 'reason', messages: [] }));
  const evict = calls.find((c) => c.url.endsWith('/api/generate'));
  assert.ok(evict, 'expected an eviction call');
  assert.equal(evict!.body.model, 'qwen3.5:0.8b');
  assert.equal(evict!.body.keep_alive, 0);
  llm.stopIdleEviction();
});

test('idle sweep unloads a heavy profile that has not been used recently', async () => {
  // Drive the LLM through one chat call so a heavy profile becomes resident,
  // then advance the clock past the idle threshold and trigger the sweep.
  const calls: Array<{ url: string; body: { model: string; keep_alive?: number | string } }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      model: string;
      keep_alive?: number | string;
    };
    calls.push({ url: String(url), body });
    if (String(url).endsWith('/api/generate')) return new Response('{}', { status: 200 });
    return streamingResponse([
      JSON.stringify({ model: body.model, message: { content: 'ok' }, done: true }),
    ]);
  };
  let t = 0;
  const llm = createOllama({
    baseUrl: 'http://x',
    log: silentLogger(),
    fetchImpl: fetchImpl as unknown as typeof fetch,
    profiles: { reason: { model: 'qwen3.5:9b', contextTokens: 8192, heavy: true } },
    idleEvictionMs: 1000,
    // Tick fast so the sweep fires inside the test window.
    idleEvictionTickMs: 5,
    now: () => t,
  });
  await collect(llm.chat({ profile: 'reason', messages: [] }));
  // Advance virtual clock past the idle window. The real setInterval still
  // ticks against wall time, but `now` is what the sweep compares.
  t = 10_000;
  // Wait a few ticks for the sweep to fire.
  await new Promise((r) => setTimeout(r, 30));
  const unload = calls.find((c) => c.url.endsWith('/api/generate') && c.body.keep_alive === 0);
  assert.ok(unload, 'idle sweep should have issued an unload');
  assert.equal(unload!.body.model, 'qwen3.5:9b');
  llm.stopIdleEviction();
});

test('releaseHeavy() unloads the resident heavy model immediately', async () => {
  // The eager-unload path: background executors call releaseHeavy() the moment
  // their work drains so a one-shot reasoning turn doesn't pin RAM for the whole
  // keep_alive window. WHY it matters: on a Pi a 9b sitting idle for 5–10 min is
  // the difference between the box being usable and swapping.
  const calls: Array<{ url: string; body: { model: string; keep_alive?: number | string } }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { model: string; keep_alive?: number | string };
    calls.push({ url: String(url), body });
    if (String(url).endsWith('/api/generate')) return new Response('{}', { status: 200 });
    return streamingResponse([
      JSON.stringify({ model: body.model, message: { content: 'ok' }, done: true }),
    ]);
  };
  const llm = createOllama({
    baseUrl: 'http://x',
    log: silentLogger(),
    fetchImpl: fetchImpl as unknown as typeof fetch,
    profiles: { reason: { model: 'qwen3.5:9b', contextTokens: 8192, heavy: true } },
  });
  await collect(llm.chat({ profile: 'reason', messages: [] }));
  await llm.releaseHeavy!();
  const unload = calls.find((c) => c.url.endsWith('/api/generate') && c.body.keep_alive === 0);
  assert.ok(unload, 'releaseHeavy should have issued an unload');
  assert.equal(unload!.body.model, 'qwen3.5:9b');
  llm.stopIdleEviction();
});

test('releaseHeavy() skips the unload while a heavy call is in flight', async () => {
  // The cross-component safety guard: one task finishing must not unload the
  // model an agent-queue task is mid-using (agent tasks bypass the queue's heavy
  // governor, so the two can overlap on the single Ollama heavy slot). WHY a
  // test: without the in-flight guard the unload would yank the model out from
  // under a live generation and force a mid-task cold reload.
  let releaseFetch: () => void = () => {};
  const fetchGate = new Promise<void>((r) => {
    releaseFetch = r;
  });
  const calls: Array<{ url: string; body: { model: string; keep_alive?: number | string } }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { model: string; keep_alive?: number | string };
    calls.push({ url: String(url), body });
    if (String(url).endsWith('/api/generate')) return new Response('{}', { status: 200 });
    await fetchGate; // hold the chat call in flight until the test releases it
    return streamingResponse([
      JSON.stringify({ model: body.model, message: { content: 'ok' }, done: true }),
    ]);
  };
  const llm = createOllama({
    baseUrl: 'http://x',
    log: silentLogger(),
    fetchImpl: fetchImpl as unknown as typeof fetch,
    profiles: { reason: { model: 'qwen3.5:9b', contextTokens: 8192, heavy: true } },
  });
  const generateCount = (): number =>
    calls.filter((c) => c.url.endsWith('/api/generate') && c.body.keep_alive === 0).length;

  // Start a heavy call and let it park inside fetch — residentHeavy is now set
  // and heavyInFlight > 0.
  const consumer = collect(llm.chat({ profile: 'reason', messages: [] }));
  await new Promise((r) => setTimeout(r, 10));
  await llm.releaseHeavy!();
  assert.equal(generateCount(), 0, 'must not unload a model that is still generating');

  // Let the call finish, then release again — now the unload goes through.
  releaseFetch();
  await consumer;
  await llm.releaseHeavy!();
  assert.equal(generateCount(), 1, 'unload should fire once the heavy call is done');
  assert.equal(calls.find((c) => c.url.endsWith('/api/generate'))!.body.model, 'qwen3.5:9b');
  llm.stopIdleEviction();
});

test('releaseHeavy() is a no-op when no heavy model is resident', async () => {
  // A tiny-only profile never becomes resident-heavy, so releaseHeavy must not
  // issue an unload — otherwise a finishing agent on a tiny model would force a
  // cold reload of the shared interactive chat model.
  const calls: Array<{ url: string }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { model: string };
    calls.push({ url: String(url) });
    if (String(url).endsWith('/api/generate')) return new Response('{}', { status: 200 });
    return streamingResponse([
      JSON.stringify({ model: body.model, message: { content: 'ok' }, done: true }),
    ]);
  };
  const llm = createOllama({
    baseUrl: 'http://x',
    log: silentLogger(),
    fetchImpl: fetchImpl as unknown as typeof fetch,
    profiles: { chat: { model: 'qwen3.5:0.8b', contextTokens: 2048, heavy: false } },
  });
  await collect(llm.chat({ profile: 'chat', messages: [] }));
  await llm.releaseHeavy!();
  assert.equal(
    calls.filter((c) => c.url.endsWith('/api/generate')).length,
    0,
    'no unload should be issued when nothing heavy is resident',
  );
  llm.stopIdleEviction();
});

// --- thinking suppression, driven by the Ollama capability probe ----------
// Capture the /api/chat request body of a single chat() call so we can assert
// on the `think` parameter and the /no_think system prefix. `capabilities`
// simulates what Ollama's /api/show reports for the model; pass 'unavailable'
// to simulate a probe that can't answer (old Ollama / model not pulled), which
// forces the tag-heuristic fallback.
async function captureChatBody(opts: {
  model: string;
  thinkMode?: 'auto' | 'on' | 'off';
  // Per-call ChatOptions.thinkMode override (distinct from the profile's).
  callThinkMode?: 'auto' | 'on' | 'off';
  capabilities: string[] | 'unavailable';
  messages: { role: 'system' | 'user'; content: string }[];
}): Promise<{ think?: boolean; messages: Array<{ role: string; content: string }> }> {
  let captured: { think?: boolean; messages: Array<{ role: string; content: string }> } | null =
    null;
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith('/api/show')) {
      if (opts.capabilities === 'unavailable') return new Response('not found', { status: 404 });
      return new Response(JSON.stringify({ capabilities: opts.capabilities }), { status: 200 });
    }
    captured = JSON.parse(String(init?.body));
    return streamingResponse([
      JSON.stringify({ model: opts.model, message: { content: 'ok' }, done: true }),
    ]);
  };
  const llm = createOllama({
    baseUrl: 'http://x',
    log: silentLogger(),
    fetchImpl: fetchImpl as unknown as typeof fetch,
    profiles: {
      chat: {
        model: opts.model,
        contextTokens: 2048,
        heavy: false,
        ...(opts.thinkMode ? { thinkMode: opts.thinkMode } : {}),
      },
    },
  });
  await collect(
    llm.chat({
      profile: 'chat',
      messages: opts.messages,
      ...(opts.callThinkMode ? { thinkMode: opts.callThinkMode } : {}),
    }),
  );
  llm.stopIdleEviction();
  assert.ok(captured, 'expected a captured chat body');
  return captured!;
}

const SYS_USER = [
  { role: 'system' as const, content: 'You are Modulus.' },
  { role: 'user' as const, content: 'hi' },
];

test('a probed thinking model is suppressed under auto (think:false + /no_think)', async () => {
  // Gemma 4 advertises a thinking capability, so on the small-device default it
  // must be suppressed exactly like qwen3 — otherwise it burns CPU on hidden
  // <think> blocks the user never sees.
  const body = await captureChatBody({
    model: 'gemma4:12b',
    capabilities: ['completion', 'tools', 'thinking', 'vision'],
    messages: SYS_USER,
  });
  assert.equal(body.think, false);
  assert.match(body.messages[0]!.content, /^\/no_think/);
});

test('a probed non-thinking model is never suppressed, even under thinkMode off', async () => {
  // Gemma 3 reports no thinking capability; Ollama errors if sent the `think`
  // parameter, so an explicit thinkMode:'off' must be a no-op for it.
  const body = await captureChatBody({
    model: 'gemma3:4b',
    thinkMode: 'off',
    capabilities: ['completion', 'tools', 'vision'],
    messages: SYS_USER,
  });
  assert.equal('think' in body, false);
  assert.equal(body.messages[0]!.content, 'You are Modulus.');
});

test('qwen3 with a thinking capability is suppressed under auto', async () => {
  const body = await captureChatBody({
    model: 'qwen3.5:0.8b',
    capabilities: ['completion', 'tools', 'thinking'],
    messages: SYS_USER,
  });
  assert.equal(body.think, false);
  assert.match(body.messages[0]!.content, /^\/no_think/);
});

test('when the probe is unavailable, the tag heuristic decides (gemma4 → suppress)', async () => {
  // Probe fails => fall back to modelFamily(), which knows gemma4+ reasons.
  const body = await captureChatBody({
    model: 'gemma4:12b',
    capabilities: 'unavailable',
    messages: SYS_USER,
  });
  assert.equal(body.think, false);
  assert.match(body.messages[0]!.content, /^\/no_think/);
});

test('a per-call thinkMode overrides the profile (force think on a suppressing profile)', async () => {
  // The panel's per-turn toggle sets ChatOptions.thinkMode, which must beat the
  // profile default. Profile says 'off' (suppress), the call says 'on' — the
  // model is forced to think: think:true is sent explicitly (deterministic
  // rather than relying on the model default) and no /no_think is injected.
  const body = await captureChatBody({
    model: 'qwen3.5:0.8b',
    thinkMode: 'off',
    callThinkMode: 'on',
    capabilities: ['completion', 'tools', 'thinking'],
    messages: SYS_USER,
  });
  assert.equal(body.think, true);
  assert.equal(body.messages[0]!.content, 'You are Modulus.');
});

test('when the probe is unavailable, an unknown model still honours explicit off', async () => {
  // Probe can't answer and the tag is unrecognised => 'unknown', so an explicit
  // thinkMode:'off' is honoured (the historical behaviour for opted-in users).
  const body = await captureChatBody({
    model: 'llama3.2:3b',
    thinkMode: 'off',
    capabilities: 'unavailable',
    messages: SYS_USER,
  });
  assert.equal(body.think, false);
  assert.match(body.messages[0]!.content, /^\/no_think/);
});

test("thinkMode 'on' is a no-op on a model that can't think (no think:true sent)", async () => {
  // gemma3 rejects Ollama's `think` param. Forcing reasoning on via the panel
  // toggle must not send think:true to it — only to models that advertise it.
  const body = await captureChatBody({
    model: 'gemma3:4b',
    callThinkMode: 'on',
    capabilities: ['completion', 'tools'],
    messages: SYS_USER,
  });
  assert.equal('think' in body, false);
});

test('chat() captures message.thinking as a separate channel from content', async () => {
  const fetchImpl = async (url: string | URL | Request) => {
    if (String(url).endsWith('/api/show')) {
      return new Response(JSON.stringify({ capabilities: ['completion', 'thinking'] }), {
        status: 200,
      });
    }
    return streamingResponse([
      JSON.stringify({ model: 'qwen3.5:9b', message: { thinking: 'let me think… ' }, done: false }),
      JSON.stringify({ model: 'qwen3.5:9b', message: { content: 'The answer.' }, done: true }),
    ]);
  };
  const llm = createOllama({
    baseUrl: 'http://x',
    log: silentLogger(),
    fetchImpl: fetchImpl as unknown as typeof fetch,
    profiles: { chat: { model: 'qwen3.5:9b', contextTokens: 4096, heavy: false } },
  });
  const chunks = await collect(
    llm.chat({ profile: 'chat', messages: [{ role: 'user', content: 'hi' }], thinkMode: 'on' }),
  );
  llm.stopIdleEviction();
  assert.equal(chunks[0]!.thinking, 'let me think… ');
  assert.equal(chunks[0]!.delta, '');
  assert.equal(chunks[1]!.delta, 'The answer.');
  assert.equal(chunks[1]!.thinking, undefined);
});

test('a thinking-only stream is not treated as an empty response', async () => {
  // The gemma-reasoner regression: all tokens land in message.thinking and
  // none in content. The model DID respond, so the empty-response guard must
  // not throw — the orchestrator's own safety net handles the missing answer.
  const fetchImpl = async (url: string | URL | Request) => {
    if (String(url).endsWith('/api/show')) {
      return new Response(JSON.stringify({ capabilities: ['completion', 'thinking'] }), {
        status: 200,
      });
    }
    return streamingResponse([
      JSON.stringify({ model: 'qwen3.5:9b', message: { thinking: 'reasoning…' }, done: false }),
      JSON.stringify({ model: 'qwen3.5:9b', message: { content: '' }, done: true }),
    ]);
  };
  const llm = createOllama({
    baseUrl: 'http://x',
    log: silentLogger(),
    fetchImpl: fetchImpl as unknown as typeof fetch,
    profiles: { chat: { model: 'qwen3.5:9b', contextTokens: 4096, heavy: false } },
  });
  // Should not throw LLMEmptyResponseError.
  const chunks = await drainBreakingOnDone(
    llm.chat({ profile: 'chat', messages: [{ role: 'user', content: 'hi' }], thinkMode: 'on' }),
  );
  llm.stopIdleEviction();
  assert.equal(chunks.at(-1)!.done, true);
});
