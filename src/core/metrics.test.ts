import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createScheduler } from './scheduler.js';
import { createMetricsWriter, readMetrics } from './metrics.js';
import { createLogger } from '../util/log.js';

const log = createLogger({ level: 'error', out: () => {}, err: () => {} });

test('writeOnce snapshots scheduler stats to disk; readMetrics round-trips', () => {
  const dir = mkdtempSync(join(tmpdir(), 'modulus-metrics-'));
  try {
    const path = join(dir, 'metrics.json');
    const s = createScheduler({ log });
    s.cache.set('k', 1, 60_000);
    s.cache.get('k');
    s.cache.get('m');
    const w = createMetricsWriter({
      path,
      log,
      scheduler: s,
      startedAt: 1000,
      now: () => 5000,
    });
    w.writeOnce();
    const snap = readMetrics(path);
    assert.ok(snap);
    assert.equal(snap!.startedAt, 1000);
    assert.equal(snap!.uptimeMs, 4000);
    assert.equal(snap!.scheduler.cache.hits, 1);
    assert.equal(snap!.scheduler.cache.misses, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readMetrics returns null when file is missing or junk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'modulus-metrics-'));
  try {
    assert.equal(readMetrics(join(dir, 'nope.json')), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
