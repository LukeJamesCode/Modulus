// Smoke test: load modulus-assistant in isolation (via a directory
// junction so old module folders don't cause tool-name conflicts) and verify
// every hook it advertises actually registers. Catches manifest drift, broken
// imports, and silent dewiring.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { open } from '../../src/storage/db.js';
import { createLogger } from '../../src/util/log.js';
import { createScheduler } from '../../src/core/scheduler.js';
import { createToolRegistry } from '../../src/core/tools.js';
import { createModuleLoader } from '../../src/core/modules.js';
import type { LLM, ProfileConfig, ProfileName } from '../../src/core/llm.js';

const log = createLogger({ level: 'error', out: () => {}, err: () => {} });

const fakeLlm: LLM = {
  chat: () => {
    throw new Error('not used');
  },
  async health() {
    return { ok: true, models: [] };
  },
  listProfiles(): Record<ProfileName, ProfileConfig | null> {
    return { chat: null, reason: null, tools: null };
  },
  resolveModel() {
    return 'fake';
  },
  breakerSnapshot: () => ({
    state: 'closed',
    failures: 0,
    consecutiveSuccesses: 0,
    openedAt: null,
    retryAt: null,
  }),
  stopIdleEviction: () => {},
};

test('modulus-assistant: loads cleanly and registers all hooks', async () => {
  // Use a junction-based fake root so only this module loads — avoids
  // tool-name conflicts with the five old module folders that share names.
  const here = resolve(dirname(fileURLToPath(import.meta.url)));
  const tmp = mkdtempSync(join(tmpdir(), 'ged-smoke-'));
  try {
    const fakeRoot = join(tmp, 'roots');
    mkdirSync(fakeRoot);
    // 'junction' type works without elevation on Windows; Node resolves junctions
    // to real paths so all relative imports inside the module still resolve.
    symlinkSync(here, join(fakeRoot, 'modulus-assistant'), 'junction');

    const db = open({ path: join(tmp, 'g.db') });
    const tools = createToolRegistry({ log });
    const sched = createScheduler({ log });
    const loader = createModuleLoader({
      roots: [fakeRoot],
      stateRoot: join(tmp, 'state'),
      db,
      llm: fakeLlm,
      log,
      scheduler: sched,
      tools,
      hostVersion: '0.1.0',
      chatId: 0,
      watch: false,
    });
    await loader.loadAll();

    const ext = loader.list().find((e) => e.name === 'modulus-assistant');
    assert.ok(ext, 'module should appear in loader list');
    assert.equal(ext!.error, undefined, `load error: ${String(ext!.error ?? 'none')}`);

    // ── All 21 tools ─────────────────────────────────────────────────────────
    const expectedTools = [
      // Calendar (4)
      'calendar_list_events',
      'calendar_add_event',
      'calendar_quick_add',
      'calendar_delete_event',
      // Tasks (5)
      'tasks_list',
      'tasks_add',
      'tasks_complete',
      'tasks_delete',
      'tasks_list_tasklists',
      // Reminders (3)
      'reminder_set',
      'reminder_list',
      'reminder_cancel',
      // Weather (1)
      'weather_get',
      // Briefing (2)
      'briefing_today',
      'briefing_tomorrow',
      // Planning (4)
      'plan_day',
      'find_free_slot',
      'smart_schedule_task',
      'weather_reschedule_check',
      // Learned routines (2)
      'learned_routine_list',
      'learned_routine_delete',
    ];
    for (const name of expectedTools) {
      assert.ok(tools.get(name), `expected tool "${name}" to be registered`);
    }

    // ── All 13 commands ───────────────────────────────────────────────────────
    const cmds = loader
      .commands()
      .filter((c) => c.module === 'modulus-assistant')
      .map((c) => c.name)
      .sort();
    assert.deepEqual(cmds, [
      'addevent',
      'delevent',
      'done',
      'events',
      'morningbrief',
      'nightbrief',
      'quickadd',
      'remind',
      'reminders',
      'tasks',
      'todo',
      'todos',
      'weather',
    ]);

    // ── cron jobs ─────────────────────────────────────────────────────────────
    // The weather-reschedule sweep is split across each configured
    // `weather_reschedule_times` entry (defaults are 06:00 + 18:00). When
    // there's exactly one time the name stays bare; with two it suffixes -1/-2.
    const jobs = sched.list().filter((j) => j.module === 'modulus-assistant');
    const jobNames = jobs.map((j) => j.name).sort();
    assert.deepEqual(jobNames, [
      'event-reminder-sweep',
      'learned-routine-delivery-sweep',
      'learned-routine-sweep',
      'morning-briefing',
      'night-briefing',
      'reminder-sweep',
      'weather-reschedule-sweep-1',
      'weather-reschedule-sweep-2',
    ]);

    // event-reminder-sweep runs every 5 minutes
    const nudgeSweep = jobs.find((j) => j.name === 'event-reminder-sweep');
    assert.equal(nudgeSweep?.cron, '*/5 * * * *');

    // ── 1 auth flow ───────────────────────────────────────────────────────────
    const flows = loader.authFlows().filter((f) => f.module === 'modulus-assistant');
    assert.equal(flows.length, 1, 'should declare exactly one auth flow');

    // ── Migration tables ──────────────────────────────────────────────────────
    for (const table of [
      'reminders',
      'calendar_nudges_sent',
      'smart_scheduled_links',
      'routine_rules',
      'routine_events',
    ]) {
      const row = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
        .get(table) as { name: string } | undefined;
      assert.ok(row, `migration should create table "${table}"`);
    }

    // ── Graceful degradation without credentials ──────────────────────────────
    const calOut = await tools.get('calendar_list_events')!.invoke({}, { log });
    assert.match(String(calOut), /not configured/i);

    const taskOut = await tools.get('tasks_list')!.invoke({}, { log });
    assert.match(String(taskOut), /not configured/i);

    const reminderOut = await tools.get('reminder_list')!.invoke({}, { log });
    assert.match(String(reminderOut), /No upcoming/i);

    // Prompt fragment contributed (prompt.md content)
    assert.match(loader.promptFragment(), /calendar/i);

    await loader.shutdown();
    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('modulus-assistant: task add intent exposes a tiny tool set', async () => {
  const here = resolve(dirname(fileURLToPath(import.meta.url)));
  const tmp = mkdtempSync(join(tmpdir(), 'ged-intent-'));
  let db: ReturnType<typeof open> | undefined;
  let loader: ReturnType<typeof createModuleLoader> | undefined;
  try {
    const fakeRoot = join(tmp, 'roots');
    mkdirSync(fakeRoot);
    symlinkSync(here, join(fakeRoot, 'modulus-assistant'), 'junction');

    db = open({ path: join(tmp, 'g.db') });
    const tools = createToolRegistry({ log });
    const sched = createScheduler({ log });
    loader = createModuleLoader({
      roots: [fakeRoot],
      stateRoot: join(tmp, 'state'),
      db,
      llm: fakeLlm,
      log,
      scheduler: sched,
      tools,
      hostVersion: '0.1.0',
      chatId: 0,
      watch: false,
    });
    await loader.loadAll();

    const inScope = new Set(['modulus-assistant']);
    const schemas = tools.schemasFor(inScope, 'add buy milk to my todo list');
    assert.deepEqual(
      schemas.map((s) => s.function.name),
      ['tasks_add'],
    );

    const eventSchemas = tools.schemasFor(inScope, 'add an event tomorrow at 3pm');
    assert.ok(
      eventSchemas.some((s) => s.function.name === 'calendar_add_event'),
      'calendar add should be available for event creation',
    );
    assert.equal(
      eventSchemas.some((s) => s.function.name === 'tasks_add'),
      false,
      'tasks_add should not be exposed for event creation',
    );
  } finally {
    await loader?.shutdown();
    db?.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});
