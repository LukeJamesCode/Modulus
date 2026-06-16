import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { handleThink } from './telegram.js';

test('handleThink resolves on/off/auto and a bare /think means on', () => {
  assert.equal(handleThink('on').mode, 'on');
  assert.equal(handleThink('off').mode, 'off');
  assert.equal(handleThink('auto').mode, 'auto');
  // Bare /think (no arg) is the everyday "think about it" → reasoning on.
  assert.equal(handleThink('').mode, 'on');
  // Tolerates surrounding space and case.
  assert.equal(handleThink('  OFF  ').mode, 'off');
});

test('handleThink rejects an unknown argument without choosing a mode', () => {
  const r = handleThink('maybe');
  assert.equal(r.mode, null); // caller persists nothing
  assert.match(r.reply, /Usage: \/think/);
});

test('handleThink returns a distinct confirmation per mode', () => {
  assert.match(handleThink('on').reply, /Reasoning on/);
  assert.match(handleThink('off').reply, /Fast mode on/);
  assert.match(handleThink('auto').reply, /auto/);
});
