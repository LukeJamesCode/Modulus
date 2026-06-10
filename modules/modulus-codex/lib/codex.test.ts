import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { extractText, callCodex, probeAccess, parseRetryAfter, CodexApiError } from './codex.js';

// Build a Server-Sent Events response body the way the Codex backend streams it.
function sse(events: object[]): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

test('extractText reads the output_text convenience field', () => {
  assert.equal(extractText({ output_text: 'hello' }), 'hello');
  assert.equal(extractText({ output_text: ['a', 'b'] }), 'ab');
});

test('extractText walks the structured output array', () => {
  const json = {
    output: [
      {
        type: 'message',
        content: [
          { type: 'output_text', text: 'part1 ' },
          { type: 'output_text', text: 'part2' },
        ],
      },
    ],
  };
  assert.equal(extractText(json), 'part1 part2');
});

test('extractText returns empty string when there is nothing', () => {
  assert.equal(extractText({}), '');
  assert.equal(extractText({ output: [] }), '');
});

test('callCodex streams, sends auth + account headers, and folds the SSE result', async () => {
  let seenHeaders: Record<string, string> = {};
  let seenUrl = '';
  let seenBody: { stream?: boolean } = {};
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    seenUrl = url;
    seenHeaders = (init?.headers as Record<string, string>) ?? {};
    seenBody = JSON.parse(String(init?.body)) as { stream?: boolean };
    return sse([
      { type: 'response.output_text.delta', delta: 'done' },
      { type: 'response.completed', response: { usage: { input_tokens: 12, output_tokens: 34 } } },
    ]);
  }) as unknown as typeof fetch;

  const result = await callCodex({
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    accessToken: 'TOK',
    accountId: 'acct_1',
    model: 'gpt-5-codex',
    prompt: 'do the thing',
    maxOutputTokens: 100,
    timeoutMs: 5_000,
    fetchImpl: fakeFetch,
  });

  assert.equal(seenUrl, 'https://chatgpt.com/backend-api/codex/responses');
  assert.equal(seenHeaders['authorization'], 'Bearer TOK');
  assert.equal(seenHeaders['chatgpt-account-id'], 'acct_1');
  assert.equal(seenBody.stream, true, 'must request streaming');
  assert.equal(result.text, 'done');
  assert.equal(result.promptTokens, 12);
  assert.equal(result.completionTokens, 34);
});

test('callCodex falls back to the completed event text when no deltas arrive', async () => {
  const fakeFetch = (async () =>
    sse([
      {
        type: 'response.completed',
        response: {
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'final only' }] }],
          usage: { input_tokens: 1, output_tokens: 2 },
        },
      },
    ])) as unknown as typeof fetch;

  const result = await callCodex({
    baseUrl: 'https://x/codex',
    accessToken: 'T',
    accountId: null,
    model: 'm',
    prompt: 'p',
    maxOutputTokens: 10,
    timeoutMs: 1_000,
    fetchImpl: fakeFetch,
  });
  assert.equal(result.text, 'final only');
});

test('callCodex surfaces a stream error event as CodexApiError', async () => {
  const fakeFetch = (async () =>
    sse([
      { type: 'response.failed', response: { error: { message: 'model exploded' } } },
    ])) as unknown as typeof fetch;
  await assert.rejects(
    callCodex({
      baseUrl: 'https://x/codex',
      accessToken: 'T',
      accountId: null,
      model: 'm',
      prompt: 'p',
      maxOutputTokens: 10,
      timeoutMs: 1_000,
      fetchImpl: fakeFetch,
    }),
    /model exploded/,
  );
});

test('callCodex throws CodexApiError on a 401', async () => {
  const fakeFetch = (async () =>
    new Response('unauthorized', { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(
    callCodex({
      baseUrl: 'https://x/codex',
      accessToken: 'T',
      accountId: null,
      model: 'm',
      prompt: 'p',
      maxOutputTokens: 10,
      timeoutMs: 1_000,
      fetchImpl: fakeFetch,
    }),
    (e: unknown) => e instanceof CodexApiError && e.status === 401,
  );
});

test('callCodex surfaces a 429 with the Retry-After seconds', async () => {
  const fakeFetch = (async () =>
    new Response('rate limited', {
      status: 429,
      headers: { 'retry-after': '42' },
    })) as unknown as typeof fetch;
  await assert.rejects(
    callCodex({
      baseUrl: 'https://x/codex',
      accessToken: 'T',
      accountId: null,
      model: 'm',
      prompt: 'p',
      maxOutputTokens: 10,
      timeoutMs: 1_000,
      fetchImpl: fakeFetch,
    }),
    (e: unknown) => e instanceof CodexApiError && e.status === 429 && e.retryAfterSeconds === 42,
  );
});

test('parseRetryAfter reads delta-seconds and an HTTP date', () => {
  assert.equal(parseRetryAfter(new Headers({ 'retry-after': '30' })), 30);
  assert.equal(parseRetryAfter(new Headers()), undefined);
  const future = new Date(Date.now() + 120_000).toUTCString();
  const secs = parseRetryAfter(new Headers({ 'retry-after': future }));
  assert.ok(secs !== undefined && secs > 60 && secs <= 120);
});

test('probeAccess reports failure status without throwing', async () => {
  const fakeFetch = (async () =>
    new Response('no scope', { status: 403 })) as unknown as typeof fetch;
  const probe = await probeAccess({
    baseUrl: 'https://x/codex',
    accessToken: 'T',
    accountId: null,
    model: 'm',
    fetchImpl: fakeFetch,
  });
  assert.equal(probe.ok, false);
  assert.equal(probe.status, 403);
});
