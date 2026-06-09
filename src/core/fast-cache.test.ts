import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createFastCache, namespacedCache } from './fast-cache.js';

test('hits and misses are counted, get returns the right value', () => {
  const c = createFastCache();
  assert.equal(c.get('x'), undefined);
  c.set('x', 42, 60_000);
  assert.equal(c.get('x'), 42);
  assert.equal(c.get('y'), undefined);
  const s = c.stats();
  assert.equal(s.hits, 1);
  assert.equal(s.misses, 2);
  assert.equal(s.size, 1);
});

test('expired entries miss and are evicted', () => {
  let t = 0;
  const c = createFastCache({ now: () => t });
  c.set('x', 1, 100);
  t = 50;
  assert.equal(c.get('x'), 1);
  t = 200;
  assert.equal(c.get('x'), undefined);
  assert.equal(c.stats().size, 0);
});

test('namespacedCache shares stats with the base', () => {
  const base = createFastCache();
  const a = namespacedCache('a', base);
  const b = namespacedCache('b', base);
  a.set('k', 1, 60_000);
  b.set('k', 2, 60_000);
  // Same logical key under different namespaces => independent storage.
  assert.equal(a.get('k'), 1);
  assert.equal(b.get('k'), 2);
  // But hit-rate aggregates across both namespaces.
  assert.equal(base.stats().hits, 2);
});

test('ttl <= 0 deletes', () => {
  const c = createFastCache();
  c.set('x', 1, 60_000);
  c.set('x', 2, 0);
  assert.equal(c.get('x'), undefined);
});
