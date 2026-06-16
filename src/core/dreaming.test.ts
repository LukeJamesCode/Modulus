// Dreaming-pass tests. What matters (and why):
// - It registers exactly one 'dreaming' scheduler job at the configured cadence,
//   so housekeeping has a pulse without a second timer.
// - The registered handler drives memory.consolidate — the deterministic
//   promote/decay the whole feature delivers.
// - The gate must short-circuit: a disabled pass touches the store not at all.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open as openDb } from '../storage/db.js';
import { createLogger } from '../util/log.js';
import { setupMemory } from './memory.js';
import { setupDreaming, DEFAULT_DREAMING_CRON } from './dreaming.js';
import type { Scheduler, ScheduledJob } from './scheduler.js';

const log = createLogger({ level: 'error', out: () => {}, err: () => {} });

function setup(now?: () => Date) {
  const dir = mkdtempSync(join(tmpdir(), 'modulus-dreaming-'));
  const db = openDb({ path: join(dir, 'm.db'), log });
  const memory = setupMemory({ db, log, ...(now ? { now } : {}) });

  let registered: ScheduledJob | null = null;
  const scheduler = {
    register: (j: ScheduledJob) => {
      registered = j;
    },
  } as unknown as Scheduler;

  return {
    memory,
    getJob: () => registered,
    make: (enabled: boolean, cron?: string) =>
      setupDreaming({ memory, scheduler, log, enabled, ...(cron ? { cron } : {}) }),
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('registers a single dreaming job at the default cadence', () => {
  const h = setup();
  try {
    const d = h.make(true);
    const job = h.getJob();
    assert.ok(job);
    assert.equal(job!.name, 'dreaming');
    assert.equal(job!.module, 'core');
    assert.equal(job!.cron, DEFAULT_DREAMING_CRON);
    assert.equal(d.stats().cron, DEFAULT_DREAMING_CRON);
  } finally {
    h.cleanup();
  }
});

test('the registered handler consolidates: promotes hot rows, decays stale noise', async () => {
  let clock = Date.UTC(2026, 0, 1);
  const h = setup(() => new Date(clock));
  try {
    h.memory.remember({ content: 'frequently needed coffee preference', source: 'extraction' });
    for (let i = 0; i < 5; i++) h.memory.renderForPrompt('frequently needed coffee preference');
    h.memory.remember({ content: 'ephemeral trivia nobody asked about', source: 'extraction' });
    clock += 40 * 24 * 60 * 60 * 1000;

    const d = h.make(true);
    await h.getJob()!.handler({
      firedAt: new Date(clock),
      log,
      cache: {
        get: () => undefined,
        set: () => {},
        delete: () => {},
        clear: () => {},
        stats: () => ({ hits: 0, misses: 0, size: 0 }),
      },
    });

    assert.equal(d.stats().dreams, 1);
    assert.equal(d.stats().promoted, 1);
    assert.equal(d.stats().decayed, 1);
    assert.equal(h.memory.count(), 1, 'stale row pruned, hot row kept');
  } finally {
    h.cleanup();
  }
});

test('a disabled pass touches the store not at all', () => {
  const h = setup();
  try {
    h.memory.remember({ content: 'some hot fact', source: 'extraction' });
    for (let i = 0; i < 5; i++) h.memory.renderForPrompt('some hot fact');
    const d = h.make(false);
    const res = d.dream();
    assert.deepEqual(res, { promoted: 0, decayed: 0 });
    assert.equal(d.stats().dreams, 0);
    assert.equal(h.memory.list()[0]!.importance, 1, 'no promotion when disabled');
  } finally {
    h.cleanup();
  }
});

test('an invalid cron falls back to the default instead of throwing', () => {
  const h = setup();
  try {
    const d = h.make(true, 'not a cron');
    assert.equal(d.stats().cron, DEFAULT_DREAMING_CRON);
    assert.equal(h.getJob()!.cron, DEFAULT_DREAMING_CRON);
  } finally {
    h.cleanup();
  }
});
