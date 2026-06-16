import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../storage/db.js';
import { createLogger } from '../util/log.js';
import { createStandingOrderStore } from './standing-orders.js';
import { setupHeartbeat, DEFAULT_HEARTBEAT_CRON } from './heartbeat.js';
import type { Scheduler, ScheduledJob } from './scheduler.js';
import type { AgentQueue } from './agent-queue.js';
import type { AgentRegistry } from './agents.js';

const log = createLogger({ level: 'error', out: () => {}, err: () => {} });

function setup(existingAgents: number[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'modulus-heartbeat-'));
  const db = open({ path: join(dir, 'g.db') });
  const orders = createStandingOrderStore(db);

  let registered: ScheduledJob | null = null;
  const scheduler = { register: (j: ScheduledJob) => { registered = j; } } as unknown as Scheduler;

  const dispatched: Array<{ agentId: number; prompt: string; notifyChatId: number | null }> = [];
  const queue = {
    dispatch: (input: { agentId: number; prompt: string; notifyChatId?: number | null }) => {
      dispatched.push({ agentId: input.agentId, prompt: input.prompt, notifyChatId: input.notifyChatId ?? null });
      return { id: dispatched.length };
    },
  } as unknown as AgentQueue;

  const agents = new Set(existingAgents);
  const registry = { get: (id: number) => (agents.has(id) ? { id } : undefined) } as unknown as AgentRegistry;

  return {
    orders,
    queue,
    registry,
    dispatched,
    getJob: () => registered,
    make: (cron?: string) => setupHeartbeat({ scheduler, orders, queue, registry, log, ...(cron ? { cron } : {}) }),
    cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test('registers a single heartbeat job at the default cadence', () => {
  const h = setup();
  try {
    const hb = h.make();
    const job = h.getJob();
    assert.ok(job);
    assert.equal(job!.name, 'heartbeat');
    assert.equal(job!.cron, DEFAULT_HEARTBEAT_CRON);
    assert.equal(hb.stats().cron, DEFAULT_HEARTBEAT_CRON);
  } finally {
    h.cleanup();
  }
});

test('a beat evaluates standing orders and returns their nudges', () => {
  const h = setup();
  try {
    h.orders.create({ instruction: 'drink water', notifyChatId: 12 });
    const hb = h.make();
    const nudges = hb.beat(new Date('2026-06-15T12:00:00Z'));
    assert.equal(nudges.length, 1);
    assert.equal(nudges[0]!.chatId, 12);
    assert.equal(hb.stats().beats, 1);
    assert.equal(hb.stats().lastBeatAt, new Date('2026-06-15T12:00:00Z').getTime());
  } finally {
    h.cleanup();
  }
});

test('a beat dispatches an agentic order through the queue', () => {
  const h = setup([5]);
  try {
    h.orders.create({ instruction: 'summarise inbox', agentId: 5, notifyChatId: 3 });
    const hb = h.make();
    const nudges = hb.beat(new Date('2026-06-15T12:00:00Z'));
    assert.equal(nudges.length, 0);
    assert.equal(h.dispatched.length, 1);
    assert.deepEqual(h.dispatched[0], { agentId: 5, prompt: 'summarise inbox', notifyChatId: 3 });
  } finally {
    h.cleanup();
  }
});

test('the registered handler runs a beat and yields the nudges', async () => {
  const h = setup();
  try {
    h.orders.create({ instruction: 'posture check', notifyChatId: 8 });
    h.make();
    const result = await h.getJob()!.handler({
      firedAt: new Date('2026-06-15T12:00:00Z'),
      log,
      cache: { get: () => undefined, set: () => {}, delete: () => {}, clear: () => {}, stats: () => ({ hits: 0, misses: 0, size: 0 }) },
    });
    assert.ok(Array.isArray(result));
    assert.equal((result as unknown[]).length, 1);
  } finally {
    h.cleanup();
  }
});

test('an invalid cron falls back to the default instead of throwing', () => {
  const h = setup();
  try {
    const hb = h.make('not a cron');
    assert.equal(hb.stats().cron, DEFAULT_HEARTBEAT_CRON);
    assert.equal(h.getJob()!.cron, DEFAULT_HEARTBEAT_CRON);
  } finally {
    h.cleanup();
  }
});
