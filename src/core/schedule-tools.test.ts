import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../storage/db.js';
import { createAgentRegistry } from './agents.js';
import { createAgentScheduleStore } from './agent-schedules.js';
import { createToolRegistry } from './tools.js';
import { createLogger } from '../util/log.js';
import {
  setupScheduleTools,
  createScheduleFromText,
  CREATE_SCHEDULE_TOOL_NAME,
  type SchedulingDeps,
} from './schedule-tools.js';

const log = createLogger({ level: 'error', out: () => {}, err: () => {} });
const NOW = new Date('2026-06-15T18:00:00Z');

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'modulus-sched-tool-'));
  const db = open({ path: join(dir, 'g.db') });
  const registry = createAgentRegistry(db);
  const store = createAgentScheduleStore(db, registry);
  const deps: SchedulingDeps = { store, registry, log, timeZone: 'UTC', now: () => NOW };
  return {
    db,
    registry,
    store,
    deps,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('create_schedule tool creates a notify-only reminder from chat context', async () => {
  const { deps, store, cleanup } = setup();
  try {
    const tools = createToolRegistry({ log });
    setupScheduleTools({ ...deps, tools });
    const tool = tools.get(CREATE_SCHEDULE_TOOL_NAME);
    assert.ok(tool, 'tool registered');

    const out = await tool!.invoke(
      { when: 'every weekday at 8am', what: 'take your pills' },
      { chatId: 777, log },
    );
    assert.match(out, /Repeating #\d+/);
    const rows = store.list({ chatId: 777, active: true });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.cron, '0 8 * * 1-5');
  } finally {
    cleanup();
  }
});

test('createScheduleFromText with an agent name makes an agent schedule that notifies the chat', async () => {
  const { registry, store, deps, cleanup } = setup();
  try {
    const agent = registry.create({ name: 'briefer', systemPrompt: 'brief', toolAllowlist: [] });
    const result = await createScheduleFromText(deps, {
      chatId: 42,
      agentName: 'briefer',
      when: 'every day at 7am',
      what: 'summarise my calendar',
    });
    assert.ok(!('error' in result));
    const s = (result as { schedule: { id: number } }).schedule;
    const row = store.get(s.id)!;
    assert.deepEqual(row.agentIds, [agent.id]);
    assert.equal(row.notifyChatId, 42);
    assert.equal(row.cron, '0 7 * * *');
  } finally {
    cleanup();
  }
});

test('createScheduleFromText rejects an unknown agent', async () => {
  const { deps, cleanup } = setup();
  try {
    const result = await createScheduleFromText(deps, {
      chatId: 1,
      agentName: 'ghost',
      when: 'in 1 hour',
      what: 'x',
    });
    assert.ok('error' in result);
  } finally {
    cleanup();
  }
});

test('createScheduleFromText needs a chat or an agent', async () => {
  const { deps, cleanup } = setup();
  try {
    const result = await createScheduleFromText(deps, { when: 'in 1 hour', what: 'x' });
    assert.ok('error' in result);
  } finally {
    cleanup();
  }
});
