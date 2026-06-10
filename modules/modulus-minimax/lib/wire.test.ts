import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { toMinimaxMessages, toMinimaxTools, parseMinimaxToolCalls } from './wire.js';
import type { ChatMessage, ToolSchema } from '../../../src/core/llm.js';

test('toMinimaxMessages correctly maps standard messages', () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'You are an AI' },
    { role: 'user', content: 'Hello' },
  ];
  const out = toMinimaxMessages(messages);
  assert.deepEqual(out, [
    { role: 'system', content: 'You are an AI' },
    { role: 'user', content: 'Hello' },
  ]);
});

test('toMinimaxMessages maps tool calls', () => {
  const messages: ChatMessage[] = [
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'tc1', name: 'myTool', arguments: { a: 1 } }],
    },
  ];
  const out = toMinimaxMessages(messages);
  assert.equal(out[0].tool_calls?.[0].id, 'tc1');
  assert.equal(out[0].tool_calls?.[0].type, 'function');
  assert.equal(out[0].tool_calls?.[0].function.name, 'myTool');
  assert.equal(out[0].tool_calls?.[0].function.arguments, '{"a":1}');
});

test('toMinimaxTools formats tools correctly', () => {
  const tools: ToolSchema[] = [
    {
      type: 'function',
      function: { name: 't1', description: 'desc', parameters: { type: 'object', properties: {} } },
    },
  ];
  const out = toMinimaxTools(tools);
  assert.ok(out);
  assert.equal(out[0].type, 'function');
  assert.equal(out[0].function.name, 't1');
});

test('parseMinimaxToolCalls parses function arguments', () => {
  const raw = [{ id: 'tc1', function: { name: 'myTool', arguments: '{"b":2}' } }];
  const parsed = parseMinimaxToolCalls(raw);
  assert.ok(parsed);
  assert.equal(parsed[0].id, 'tc1');
  assert.equal(parsed[0].name, 'myTool');
  assert.deepEqual(parsed[0].arguments, { b: 2 });
});
