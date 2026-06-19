import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { toToolParameters } from './schema.js';

test('a missing or non-object schema becomes an empty object schema', () => {
  assert.deepEqual(toToolParameters(undefined), { type: 'object', properties: {} });
  assert.deepEqual(toToolParameters(null), { type: 'object', properties: {} });
  assert.deepEqual(toToolParameters('nope'), { type: 'object', properties: {} });
});

test('properties (incl. nested objects and enums) pass through; required is carried', () => {
  const input = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'a path' },
      mode: { type: 'string', enum: ['read', 'write'] },
      opts: { type: 'object', properties: { deep: { type: 'boolean' } } },
    },
    required: ['path'],
  };
  const out = toToolParameters(input);
  assert.equal(out['type'], 'object');
  assert.deepEqual(out['properties'], input.properties, 'nested schemas preserved verbatim');
  assert.deepEqual(out['required'], ['path']);
});

test('required is filtered to strings and dropped when empty', () => {
  const out = toToolParameters({ properties: { a: { type: 'string' } }, required: [] });
  assert.equal('required' in out, false);

  const out2 = toToolParameters({ properties: {}, required: ['a', 5, null, 'b'] });
  assert.deepEqual(out2['required'], ['a', 'b']);
});

test('a schema with no properties still yields a properties bag', () => {
  assert.deepEqual(toToolParameters({ type: 'object' }), { type: 'object', properties: {} });
});
