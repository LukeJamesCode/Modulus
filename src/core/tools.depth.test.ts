// Regression: validateArgs() used to recurse without a depth bound. A
// malicious extension schema (or deeply-nested user input) could blow the
// stack before any tool ran. Now bounded at 32 levels.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { validateArgs } from './tools.js';

test('validateArgs caps recursion depth instead of throwing', () => {
  // Build a 100-level-deep schema: { properties: { x: { properties: { x: ... } } } }
  type Schema = { type: 'object'; properties: Record<string, Schema> };
  let schema: Schema = { type: 'object', properties: {} };
  for (let i = 0; i < 100; i++) {
    schema = { type: 'object', properties: { x: schema } };
  }
  // Matching input.
  const input: Record<string, unknown> = {};
  let cursor: Record<string, unknown> = input;
  for (let i = 0; i < 100; i++) {
    cursor['x'] = {};
    cursor = cursor['x'] as Record<string, unknown>;
  }

  const errs = validateArgs(input, schema as unknown as Record<string, unknown>);
  assert.ok(
    errs.some((e) => e.includes('too deep')),
    `expected a 'too deep' error, got: ${errs.join(' | ')}`,
  );
});

test('validateArgs handles shallow schemas normally', () => {
  const errs = validateArgs(
    { name: 'a' },
    { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  );
  assert.deepEqual(errs, []);
});
