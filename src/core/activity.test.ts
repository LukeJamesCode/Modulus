import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../storage/db.js';
import { createActivityStore, recordActivitySafe, type ActivityStore } from './activity.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'modulus-activity-'));
  const db = open({ path: join(dir, 'g.db') });
  return {
    store: createActivityStore(db),
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const HOUR = 60 * 60_000;

test('record round-trips every field and defaults ts/created_at to now', () => {
  const { store, cleanup } = setup();
  try {
    const before = Date.now();
    const row = store.record({
      kind: 'agent_run',
      actor: 'researcher',
      trigger: 'user',
      status: 'ok',
      summary: 'Looked up the weather',
      surface: 'dashboard',
      refTable: 'agent_tasks',
      refId: 42,
    });
    assert.ok(row.id > 0);
    assert.equal(row.kind, 'agent_run');
    assert.equal(row.actor, 'researcher');
    assert.equal(row.trigger, 'user');
    assert.equal(row.status, 'ok');
    assert.equal(row.summary, 'Looked up the weather');
    assert.equal(row.surface, 'dashboard');
    assert.equal(row.refTable, 'agent_tasks');
    assert.equal(row.refId, 42);
    assert.ok(row.ts >= before && row.ts <= Date.now());
    assert.ok(row.createdAt >= before);
  } finally {
    cleanup();
  }
});

test('list is newest-first and respects since/until/kind/limit', () => {
  const { store, cleanup } = setup();
  try {
    const base = Date.now();
    store.record({ kind: 'chat_turn', actor: 'modulus', trigger: 'chat', status: 'ok', summary: 'a', ts: base - 3 * HOUR });
    store.record({ kind: 'tool_call', actor: 'modulus', trigger: 'user', status: 'blocked', summary: 'b', ts: base - 2 * HOUR });
    store.record({ kind: 'chat_turn', actor: 'modulus', trigger: 'chat', status: 'ok', summary: 'c', ts: base - 1 * HOUR });

    // Newest-first.
    const all = store.list();
    assert.deepEqual(all.map((r) => r.summary), ['c', 'b', 'a']);

    // Kind filter.
    assert.deepEqual(store.list({ kind: 'chat_turn' }).map((r) => r.summary), ['c', 'a']);

    // since is inclusive, until is exclusive.
    const windowed = store.list({ since: base - 2 * HOUR, until: base - 1 * HOUR });
    assert.deepEqual(windowed.map((r) => r.summary), ['b']);

    // Limit caps the newest rows.
    assert.deepEqual(store.list({ limit: 1 }).map((r) => r.summary), ['c']);
  } finally {
    cleanup();
  }
});

test('timeline buckets by hour, splits by trigger, counts blocked+failed as failed', () => {
  const { store, cleanup } = setup();
  try {
    // Anchor to the start of the current epoch hour so the bucket boundaries
    // are deterministic (buckets align to absolute hours, not relative to now).
    const hourStart = Math.floor(Date.now() / HOUR) * HOUR;
    // Two events land in the same (current) hour bucket, a third an hour earlier.
    store.record({ kind: 'agent_run', actor: 'x', trigger: 'schedule', status: 'ok', summary: 's1', ts: hourStart + 1_000 });
    store.record({ kind: 'tool_call', actor: 'x', trigger: 'user', status: 'failed', summary: 's2', ts: hourStart + 2_000 });
    store.record({ kind: 'tool_call', actor: 'x', trigger: 'user', status: 'blocked', summary: 's3', ts: hourStart - HOUR + 1_000 });

    const { bucketMs, buckets } = store.timeline({ days: 1, bucket: 'hour' });
    assert.equal(bucketMs, HOUR);
    // Two distinct hour buckets, oldest-first.
    assert.equal(buckets.length, 2);

    const recent = buckets[1]!;
    assert.equal(recent.total, 2);
    assert.equal(recent.failed, 1); // the 'failed' tool_call
    assert.equal(recent.byTrigger.schedule, 1);
    assert.equal(recent.byTrigger.user, 1);

    const older = buckets[0]!;
    assert.equal(older.total, 1);
    assert.equal(older.failed, 1); // 'blocked' counts as failed
  } finally {
    cleanup();
  }
});

test('recordActivitySafe is a no-op when the store is absent and never throws', () => {
  const { store, cleanup } = setup();
  try {
    // Absent store: nothing recorded, no throw.
    recordActivitySafe(undefined, undefined, {
      kind: 'chat_turn', actor: 'modulus', trigger: 'chat', status: 'ok', summary: 'ignored',
    });
    assert.equal(store.list().length, 0);

    // A throwing store is swallowed.
    const boom: ActivityStore = {
      record() { throw new Error('disk full'); },
      list: store.list,
      timeline: store.timeline,
    };
    assert.doesNotThrow(() =>
      recordActivitySafe(boom, undefined, {
        kind: 'chat_turn', actor: 'modulus', trigger: 'chat', status: 'ok', summary: 'boom',
      }),
    );

    // The real store still records.
    recordActivitySafe(store, undefined, {
      kind: 'chat_turn', actor: 'modulus', trigger: 'chat', status: 'ok', summary: 'kept',
    });
    assert.deepEqual(store.list().map((r) => r.summary), ['kept']);
  } finally {
    cleanup();
  }
});
