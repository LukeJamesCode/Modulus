import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { classifyProbeError, probeOllama } from './ollama-probe.js';

function fakeFetch(handler: (url: string) => Response | Promise<Response>): typeof fetch {
  return ((input: string | URL | Request) =>
    Promise.resolve(handler(String(input)))) as unknown as typeof fetch;
}

test('probeOllama returns models on 200', async () => {
  const fakeF = fakeFetch(
    () => new Response(JSON.stringify({ models: [{ name: 'a' }, { name: 'b' }] }), { status: 200 }),
  );
  const r = await probeOllama('http://x', fakeF);
  assert.equal(r.ok, true);
  assert.deepEqual(r.models, ['a', 'b']);
});

test('probeOllama returns ok=false on http error', async () => {
  const fakeF = fakeFetch(() => new Response('boom', { status: 500 }));
  const r = await probeOllama('http://x', fakeF);
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /500/);
});

test('probeOllama returns ok=false on network error', async () => {
  const fakeF: typeof fetch = () => Promise.reject(new Error('connection refused'));
  const r = await probeOllama('http://x', fakeF);
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /connection refused/);
});

test('probeOllama surfaces the cause code from wrapped fetch errors', async () => {
  const err = new TypeError('fetch failed');
  (err as Error & { cause?: unknown }).cause = Object.assign(new Error('connect ECONNREFUSED'), {
    code: 'ECONNREFUSED',
  });
  const fakeF: typeof fetch = () => Promise.reject(err);
  const r = await probeOllama('http://x', fakeF);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'ECONNREFUSED');
});

test('classifyProbeError buckets common failures', () => {
  assert.equal(classifyProbeError('ECONNREFUSED'), 'refused');
  assert.equal(classifyProbeError('connect ECONNREFUSED 192.168.1.50:11434'), 'refused');
  assert.equal(classifyProbeError('EHOSTUNREACH'), 'unreachable');
  assert.equal(classifyProbeError('ENETUNREACH'), 'unreachable');
  assert.equal(classifyProbeError('ENOTFOUND'), 'dns');
  assert.equal(classifyProbeError('ETIMEDOUT'), 'timeout');
  assert.equal(classifyProbeError('The operation was aborted due to timeout'), 'timeout');
  assert.equal(classifyProbeError('http 502'), 'http');
  assert.equal(classifyProbeError('something weird'), 'unknown');
  assert.equal(classifyProbeError(undefined), null);
});

test('probeOllama strips trailing slashes from URL', async () => {
  let seenUrl = '';
  const fakeF = fakeFetch((url) => {
    seenUrl = url;
    return new Response(JSON.stringify({ models: [] }), { status: 200 });
  });
  await probeOllama('http://x///', fakeF);
  assert.equal(seenUrl, 'http://x/api/tags');
});
