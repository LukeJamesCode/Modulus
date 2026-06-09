import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { TOOL_RESULT_MAX_CHARS, truncateToolResult } from './orchestrator.js';

test('truncateToolResult is a no-op when output is under the cap', () => {
  const out = 'short tool reply';
  assert.equal(truncateToolResult(out), out);
});

test('truncateToolResult clips output and appends the marker when over the cap', () => {
  const big = 'x'.repeat(TOOL_RESULT_MAX_CHARS + 500);
  const trimmed = truncateToolResult(big);
  // Head is preserved up to the cap; trailing marker tells the model the
  // tail was dropped so it can ask for a narrower query if needed.
  assert.ok(trimmed.startsWith('x'.repeat(TOOL_RESULT_MAX_CHARS)));
  assert.match(trimmed, /\[truncated\]$/);
  assert.ok(trimmed.length < big.length);
});

test('truncateToolResult honours an explicit override', () => {
  const trimmed = truncateToolResult('abcdefghij', 4);
  assert.equal(trimmed.startsWith('abcd'), true);
  assert.match(trimmed, /\[truncated\]$/);
});
