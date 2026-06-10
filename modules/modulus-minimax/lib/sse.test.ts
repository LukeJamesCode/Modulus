import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseSSEStream } from './sse.js';
import type { Logger } from '../../../src/util/log.js';

function createMockLog(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    fatal: () => {},
    child: () => createMockLog(),
  } as unknown as Logger;
}

function stringToStream(str: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(str));
      controller.close();
    },
  });
}

test('parseSSEStream accumulates tool calls and extracts tokens', async () => {
  const sseData =
    'data: {"choices":[{"index":0,"finish_reason":null,"delta":{"tool_calls":[{"index":0,"id":"tc1","function":{"name":"myTool","arguments":"{\\"a\\""}}]}}]}\n\n' +
    'data: {"choices":[{"index":0,"finish_reason":null,"delta":{"tool_calls":[{"index":0,"function":{"arguments":":1}"}}]}}]}\n\n' +
    'data: {"choices":[{"index":0,"finish_reason":"tool_calls"}], "usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n' +
    'data: [DONE]\n\n';

  const stream = stringToStream(sseData);
  const chunks = [];
  for await (const chunk of parseSSEStream(stream, 'model-test', createMockLog())) {
    chunks.push(chunk);
  }

  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].done, false);
  assert.equal(chunks[1].done, false);

  const doneChunk = chunks[2];
  assert.equal(doneChunk.done, true);
  assert.equal(doneChunk.promptTokens, 10);
  assert.equal(doneChunk.completionTokens, 5);

  assert.ok(doneChunk.toolCalls);
  assert.equal(doneChunk.toolCalls[0].name, 'myTool');
  assert.deepEqual(doneChunk.toolCalls[0].arguments, { a: 1 });
});

test('parseSSEStream throws on base_resp error', async () => {
  const sseData = 'data: {"base_resp":{"status_code":1001,"status_msg":"Invalid API Key"}}\n\n';
  const stream = stringToStream(sseData);

  let threw = false;
  try {
    for await (const _chunk of parseSSEStream(stream, 'model-test', createMockLog())) {
      // should throw
    }
  } catch (e) {
    threw = true;
    assert.match((e as Error).message, /Invalid API Key/);
  }
  assert.ok(threw);
});
