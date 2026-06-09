// Regression: parseNdjsonStream used to call JSON.parse() bare, so a single
// malformed line (network blip, proxy artefact, Ollama bug) crashed the whole
// turn out of the async iterator. Now bad lines are logged and skipped.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseNdjsonStream } from './llm.js';
import { createLogger } from '../util/log.js';

function bodyFrom(lines: string[]): ReadableStream<Uint8Array> {
  const blob = lines.join('\n');
  const bytes = new TextEncoder().encode(blob);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

test('parseNdjsonStream skips malformed JSON lines and continues', async () => {
  const warns: string[] = [];
  const log = createLogger({
    level: 'warn',
    out: () => {},
    err: (line) => warns.push(line),
  });
  const body = bodyFrom([
    'garbage not json',
    JSON.stringify({ message: { content: 'hello' }, done: false }),
    JSON.stringify({ message: { content: '' }, done: true }),
  ]);
  const chunks = [];
  for await (const c of parseNdjsonStream(body, 'fakemodel', log)) {
    chunks.push(c);
  }
  // Exactly two chunks made it through; the garbage line was skipped.
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0]!.delta, 'hello');
  assert.equal(chunks[1]!.done, true);
  // And the bad line surfaced as a warning, not a thrown exception.
  assert.ok(
    warns.some((w) => w.includes('malformed JSON')),
    'expected a "malformed JSON" warning',
  );
});

test('parseNdjsonStream falls back to empty args on bad tool_call JSON', async () => {
  const log = createLogger({ level: 'error', out: () => {}, err: () => {} });
  const body = bodyFrom([
    JSON.stringify({
      message: {
        content: '',
        tool_calls: [{ id: 'a', function: { name: 'demo', arguments: '{not valid json' } }],
      },
      done: true,
    }),
  ]);
  const chunks = [];
  for await (const c of parseNdjsonStream(body, 'fakemodel', log)) {
    chunks.push(c);
  }
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]!.toolCalls?.length, 1);
  assert.deepEqual(chunks[0]!.toolCalls?.[0]?.arguments, {});
});
