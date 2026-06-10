import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseSseEvents, parseJsonSse } from './sse.js';

function streamFrom(parts: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

test('parseSseEvents joins data lines and tolerates chunk boundaries', async () => {
  const body = streamFrom(['data: {"a"', ':1}\n', 'data: {"b":2}\n\n']);
  const events: string[] = [];
  for await (const event of parseSseEvents(body)) events.push(event);
  assert.deepEqual(events, ['{"a":1}\n{"b":2}']);
});

test('parseJsonSse stops at DONE', async () => {
  const body = streamFrom([
    'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
    'data: [DONE]\n\n',
    'data: {"ignored":true}\n\n',
  ]);
  const events: unknown[] = [];
  for await (const event of parseJsonSse(body)) events.push(event);
  assert.deepEqual(events, [{ choices: [{ delta: { content: 'hi' } }] }]);
});
