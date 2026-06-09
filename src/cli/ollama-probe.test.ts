import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { probeOllama } from './ollama-probe.js';

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

test('probeOllama strips trailing slashes from URL', async () => {
  let seenUrl = '';
  const fakeF = fakeFetch((url) => {
    seenUrl = url;
    return new Response(JSON.stringify({ models: [] }), { status: 200 });
  });
  await probeOllama('http://x///', fakeF);
  assert.equal(seenUrl, 'http://x/api/tags');
});
