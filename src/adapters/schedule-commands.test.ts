import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../storage/db.js';
import { createAgentRegistry } from '../core/agents.js';
import { createAgentScheduleStore } from '../core/agent-schedules.js';
import { createLogger } from '../util/log.js';
import {
  handleRemind,
  handleEvery,
  handleScheduleList,
  handleScheduleCommand,
} from './schedule-commands.js';
import type { SchedulingDeps } from '../core/schedule-tools.js';

const log = createLogger({ level: 'error', out: () => {}, err: () => {} });
const NOW = new Date('2026-06-15T18:00:00Z');
const CHAT = 555;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'modulus-sched-cmd-'));
  const db = open({ path: join(dir, 'g.db') });
  const registry = createAgentRegistry(db);
  const store = createAgentScheduleStore(db, registry);
  const deps: SchedulingDeps = { store, registry, log, timeZone: 'UTC', now: () => NOW };
  return {
    deps,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('/remind creates a one-shot notify-only reminder for this chat', async () => {
  const { deps, cleanup } = setup();
  try {
    const reply = await handleRemind(deps, CHAT, 'in 30 minutes, call mom');
    assert.match(reply, /Scheduled #\d+/);
    const rows = deps.store.list({ chatId: CHAT, active: true });
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0]!.agentIds, []);
    assert.equal(rows[0]!.notifyChatId, CHAT);
    assert.equal(rows[0]!.nextRunAt, NOW.getTime() + 30 * 60_000);
    assert.equal(rows[0]!.prompt, 'call mom');
  } finally {
    cleanup();
  }
});

test('/every coerces a leading-every-less phrase into a recurring cron', async () => {
  const { deps, cleanup } = setup();
  try {
    const reply = await handleEvery(deps, CHAT, 'weekday at 8am, standup');
    assert.match(reply, /Repeating #\d+/);
    const rows = deps.store.list({ chatId: CHAT, active: true });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.cron, '0 8 * * 1-5');
    assert.equal(rows[0]!.timeZone, 'UTC');
  } finally {
    cleanup();
  }
});

test('/remind without a comma returns usage', async () => {
  const { deps, cleanup } = setup();
  try {
    assert.match(await handleRemind(deps, CHAT, 'tomorrow at 9 call dentist'), /Usage: \/remind/);
  } finally {
    cleanup();
  }
});

test('/remind with an unparseable time (no model) reports it', async () => {
  const { deps, cleanup } = setup();
  try {
    assert.match(await handleRemind(deps, CHAT, 'banana pancakes, eat'), /Couldn't schedule/);
  } finally {
    cleanup();
  }
});

test('/schedules lists this chat reminders and is empty otherwise', async () => {
  const { deps, cleanup } = setup();
  try {
    assert.match(handleScheduleList(deps, CHAT), /No active reminders/);
    await handleEvery(deps, CHAT, 'weekday at 8am, standup');
    const list = handleScheduleList(deps, CHAT);
    assert.match(list, /Your reminders/);
    assert.match(list, /standup/);
    // A different chat sees none of it.
    assert.match(handleScheduleList(deps, 999), /No active reminders/);
  } finally {
    cleanup();
  }
});

test('/schedule cancel removes by id, scoped to the chat', async () => {
  const { deps, cleanup } = setup();
  try {
    await handleRemind(deps, CHAT, 'in 1 hour, stretch');
    const id = deps.store.list({ chatId: CHAT, active: true })[0]!.id;
    assert.match(handleScheduleCommand(deps, 999, `cancel ${id}`), /No reminder/);
    assert.match(handleScheduleCommand(deps, CHAT, `cancel ${id}`), /Cancelled reminder/);
    assert.equal(deps.store.list({ chatId: CHAT, active: true }).length, 0);
  } finally {
    cleanup();
  }
});

test('/schedule cancel all clears every reminder in the chat', async () => {
  const { deps, cleanup } = setup();
  try {
    await handleRemind(deps, CHAT, 'in 1 hour, a');
    await handleRemind(deps, CHAT, 'in 2 hours, b');
    assert.match(handleScheduleCommand(deps, CHAT, 'cancel all'), /Cancelled 2 reminders/);
    assert.equal(deps.store.list({ chatId: CHAT, active: true }).length, 0);
  } finally {
    cleanup();
  }
});

test('bare /schedule shows usage', () => {
  const { deps, cleanup } = setup();
  try {
    assert.match(handleScheduleCommand(deps, CHAT, ''), /Usage: \/schedule cancel/);
  } finally {
    cleanup();
  }
});
