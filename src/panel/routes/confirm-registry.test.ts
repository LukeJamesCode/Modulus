import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createConfirmRegistry } from './confirm-registry.js';

test('a parked confirm resolves by id across the whole registry', () => {
  const reg = createConfirmRegistry();
  const scope = reg.scope();
  let result: boolean | undefined;
  scope.add('c1', (ok) => {
    result = ok;
    scope.remove('c1'); // mirrors the route's finish(): settle then forget
  });
  // The POST .../confirm path looks up by id alone, without the scope.
  reg.get('c1')!(true);
  assert.equal(result, true);
  // Once settled, it is gone from the registry.
  assert.equal(reg.get('c1'), undefined);
});

test('failAll fails-closed only the scope that owns the confirm', () => {
  const reg = createConfirmRegistry();
  const a = reg.scope();
  const b = reg.scope();
  let aResult: boolean | undefined;
  let bResult: boolean | undefined;
  a.add('a1', (ok) => {
    aResult = ok;
    a.remove('a1');
  });
  b.add('b1', (ok) => {
    bResult = ok;
    b.remove('b1');
  });

  // Stream A ends (disconnect/turn end): its confirm fails closed...
  a.failAll();
  assert.equal(aResult, false);
  // ...but a sibling stream's pending confirm is untouched and still resolvable.
  assert.equal(bResult, undefined);
  reg.get('b1')!(true);
  assert.equal(bResult, true);
});

test('failAll is safe to call twice and after a confirm already settled', () => {
  const reg = createConfirmRegistry();
  const scope = reg.scope();
  let calls = 0;
  scope.add('x', (_ok) => {
    calls += 1;
    scope.remove('x');
  });
  scope.failAll();
  scope.failAll(); // a disconnect after the finally block must not double-fire
  assert.equal(calls, 1);
});
