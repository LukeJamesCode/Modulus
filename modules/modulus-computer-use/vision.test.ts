// Vision: the JSON-in-text parser (the robustness-critical bit) and the
// supportsVision fail-closed gate for the local backend. The cloud path is a
// thin fetch translation exercised via decide() with a stubbed fetch.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { extractDecision, createVision } from './vision.js';
import type { ChatChunk } from '../../src/core/llm.js';

async function* oneChunk(text: string): AsyncIterable<ChatChunk> {
  yield { delta: text, done: true, model: 'fake' };
}

test('extractDecision: plain JSON', () => {
  const d = extractDecision('{"action":"click","args":{"x":12,"y":34},"rationale":"hit it"}');
  assert.equal(d.action, 'click');
  assert.equal(d.args['x'], 12);
  assert.equal(d.rationale, 'hit it');
});

test('extractDecision: prose- and fence-wrapped JSON', () => {
  const wrapped = 'Sure! ```json\n{"action":"type","args":{"text":"hi"}}\n``` done';
  const d = extractDecision(wrapped);
  assert.equal(d.action, 'type');
  assert.equal(d.args['text'], 'hi');
});

test('extractDecision: braces inside a string value do not confuse the scanner', () => {
  const d = extractDecision('{"action":"type","args":{"text":"a {b} c"},"rationale":"x"}');
  assert.equal(d.args['text'], 'a {b} c');
});

test('extractDecision: throws when no object present', () => {
  assert.throws(() => extractDecision('no json here'), /no JSON object/);
});

test('decide(local): returns the parsed action when the model is vision-capable', async () => {
  const llm = {
    async supportsVision() {
      return true;
    },
    chat() {
      return oneChunk('{"action":"click","args":{"x":5,"y":6},"rationale":"r"}');
    },
  };
  const vision = createVision({ llm: llm as never, fetch: (async () => {
    throw new Error('fetch should not be called for local');
  }) as never });
  const d = await vision.decide(
    { backend: 'local', localModel: 'vlm', cloudEndpoint: '', cloudModel: '', cloudApiKey: '' },
    { goal: 'g', screenshotB64: 'AAAA', width: 100, height: 100, history: [] },
  );
  assert.equal(d.action, 'click');
  assert.equal(d.args['x'], 5);
});

test('decide(local): fails closed when the model is not vision-capable', async () => {
  const llm = {
    async supportsVision() {
      return false;
    },
    chat() {
      throw new Error('chat must not be called when vision is unsupported');
    },
  };
  const vision = createVision({ llm: llm as never, fetch: (async () => {
    throw new Error('no fetch');
  }) as never });
  await assert.rejects(
    vision.decide(
      { backend: 'local', localModel: 'text-only', cloudEndpoint: '', cloudModel: '', cloudApiKey: '' },
      { goal: 'g', screenshotB64: 'AAAA', width: 10, height: 10, history: [] },
    ),
    /not vision-capable/,
  );
});

test('decide(cloud): translates to the Messages API and parses the text block', async () => {
  let captured: { url: string; body: Record<string, unknown> } | null = null;
  const fetchImpl = async (url: string, init: { body: string }) => {
    captured = { url, body: JSON.parse(init.body) };
    return {
      ok: true,
      async json() {
        return { content: [{ type: 'text', text: '{"action":"done","args":{"summary":"ok"}}' }] };
      },
    };
  };
  const vision = createVision({ llm: {} as never, fetch: fetchImpl as never });
  const d = await vision.decide(
    {
      backend: 'cloud',
      localModel: '',
      cloudEndpoint: 'https://api.anthropic.com/v1/messages',
      cloudModel: 'claude-x',
      cloudApiKey: 'k',
    },
    { goal: 'g', screenshotB64: 'IMG', width: 800, height: 600, history: [] },
  );
  assert.equal(d.action, 'done');
  assert.ok(captured);
  assert.equal(captured!.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(captured!.body['model'], 'claude-x');
});
