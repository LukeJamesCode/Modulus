import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { looksLikeFakeToolCall } from './orchestrator.js';

const TOOLS = new Set([
  'tasks_list',
  'tasks_add',
  'briefing_tomorrow',
  'reminder_set',
  'calendar_list_events',
]);

test('detects markdown JSON-block fake tool call', () => {
  const txt = '```json\n{ "type": "briefing_tomorrow", "local_time": "Friday" }\n```';
  assert.equal(looksLikeFakeToolCall(txt, TOOLS), true);
});

test('detects ```json without newline', () => {
  const txt = '```json { "type": "briefing_tomorrow", "from": "self" } ```';
  assert.equal(looksLikeFakeToolCall(txt, TOOLS), true);
});

test('detects bracketed tool name at start', () => {
  assert.equal(looksLikeFakeToolCall('[tasks_list]', TOOLS), true);
  assert.equal(looksLikeFakeToolCall('[reminder_set] at 15:00', TOOLS), true);
});

test('detects backticked tool name at start', () => {
  assert.equal(looksLikeFakeToolCall('`reminder_set`', TOOLS), true);
  assert.equal(looksLikeFakeToolCall('`tasks_add` with `title`: "Buy milk"', TOOLS), true);
});

test('detects function-call-shape fake call at start', () => {
  assert.equal(looksLikeFakeToolCall('`tasks_add`("Buy milk")', TOOLS), true);
});

test('does NOT flag a normal reply that mentions a tool name later', () => {
  // The model talking about tools in conversation is fine — only flag when
  // the WHOLE reply is shaped like a tool call.
  assert.equal(
    looksLikeFakeToolCall('Sure — I will use tasks_add to record that for you.', TOOLS),
    false,
  );
});

test('does NOT flag a reply that starts with a bracket but no tool name', () => {
  assert.equal(looksLikeFakeToolCall('[note]: see calendar for details.', TOOLS), false);
});

test('does NOT flag a JSON block that is not a tool call', () => {
  const txt = '```json\n{ "weather": "sunny", "temp": 22 }\n```';
  assert.equal(looksLikeFakeToolCall(txt, TOOLS), false);
});

test('does NOT flag a function-call-shape with an unknown name', () => {
  // ask_task isn't a registered tool — model is hallucinating a name.
  // We only sanitize when the model fakes a REAL tool name.
  assert.equal(looksLikeFakeToolCall('`ask_task`("buy_milk")', TOOLS), false);
});

test('does NOT flag the empty string', () => {
  assert.equal(looksLikeFakeToolCall('', TOOLS), false);
  assert.equal(looksLikeFakeToolCall('   \n\t  ', TOOLS), false);
});

// The domain hallucination guards (fake delete-confirmation, fake weather
// forecast) moved out of core into modulus-everyday-assistant, which owns the
// tools they guard. Their tests live alongside them in
// extensions/modulus-everyday-assistant/guards.test.ts.
