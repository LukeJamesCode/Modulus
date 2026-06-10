// Tests for the day-planning tools: find_free_slot and smart_schedule_task.
// Uses globalThis.fetch mocking so no real HTTP calls are made.
//
// Note: findFreeSlotsInternal uses Date.setHours (local time) for earliest/
// latest boundaries. Tests that rely on gap arithmetic use wide bounds
// (00:00 – 23:59) to be timezone-safe on any CI host.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../../../src/storage/db.js';
import type { Host } from '../../../src/core/modules.js';
import { findFreeSlotsInternal } from './planning.js';
import { register as registerPlanning } from './planning.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function mockJsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

type ToolInvoke = (args: unknown, ctx: { log: unknown }) => Promise<unknown>;

function registerTools(host: Host): Map<string, ToolInvoke> {
  const handlers = new Map<string, ToolInvoke>();
  const fakeTools = {
    register(def: { name: string; invoke: ToolInvoke }) {
      handlers.set(def.name, def.invoke);
    },
  };
  registerPlanning({ ...host, tools: fakeTools } as unknown as Host);
  return handlers;
}

const fakeLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function makeHost(db: ReturnType<typeof open>, extra?: Record<string, string>): Host {
  const settings = new Map<string, string>([
    ['google_client_id', 'test-cid'],
    ['google_client_secret', 'test-csec'],
    ['google_refresh_token', 'test-rtok'],
    ['calendar_id', 'primary'],
    ['default_tasklist', '@default'],
    ...(extra ? (Object.entries(extra) as [string, string][]) : []),
  ]);
  return {
    settings: {
      get<T>(key: string, def?: T): T | undefined {
        return (settings.get(key) as T) ?? def;
      },
      set() {},
    },
    db,
    telegram: { knownChats: () => [], defaultChatId: null },
  } as unknown as Host;
}

// Fetch mock that handles token exchange + calendar list + optional events.
function makeFetchMock(calendarItems: unknown[], addEventResponse?: unknown): typeof fetch {
  return async (input: RequestInfo | URL): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    if (url.includes('/token')) {
      return mockJsonResponse({ access_token: 'AT', expires_in: 3600 });
    }
    if (url.includes('/calendars/')) {
      return mockJsonResponse({ items: calendarItems });
    }
    if (url.includes('/lists/') && url.includes('/tasks')) {
      // tasks listTasks
      return mockJsonResponse({ items: [] });
    }
    if (addEventResponse) {
      return mockJsonResponse(addEventResponse);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
}

// ── find_free_slot tests ──────────────────────────────────────────────────────

test('findFreeSlotsInternal: no calendar configured returns empty with warning', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ged-plan-'));
  try {
    const db = open({ path: join(tmp, 'g.db') });
    // Host with no credentials → getCalClient returns undefined
    const noCredHost = {
      settings: { get: () => undefined, set: () => {} },
      db,
      telegram: { knownChats: () => [], defaultChatId: null },
    } as unknown as Host;

    const result = await findFreeSlotsInternal(noCredHost, { date: '2026-05-15' });
    assert.equal(result.slots.length, 0);
    assert.ok(result.warning, 'should include a warning explaining why');
    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('findFreeSlotsInternal: empty calendar returns at least one slot', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ged-plan-empty-'));
  try {
    const db = open({ path: join(tmp, 'g.db') });
    const host = makeHost(db);
    const origFetch = globalThis.fetch;
    globalThis.fetch = makeFetchMock([]);
    try {
      const result = await findFreeSlotsInternal(host, {
        date: '2026-05-15',
        duration_minutes: 30,
        earliest: '00:00',
        latest: '23:59',
        count: 1,
      });
      assert.ok(result.slots.length >= 1, 'empty day should yield at least one free slot');
      assert.ok(result.slots[0]!.startIso, 'slot should have a startIso');
      assert.ok(result.slots[0]!.endIso, 'slot should have an endIso');
    } finally {
      globalThis.fetch = origFetch;
    }
    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('findFreeSlotsInternal: all-day event present emits warning but does not block time', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ged-plan-allday-'));
  try {
    const db = open({ path: join(tmp, 'g.db') });
    const host = makeHost(db);
    const allDayEvent = {
      id: 'ev-allday',
      summary: 'Bank holiday',
      start: { date: '2026-05-15' },
      end: { date: '2026-05-16' },
    };
    const origFetch = globalThis.fetch;
    globalThis.fetch = makeFetchMock([allDayEvent]);
    try {
      const result = await findFreeSlotsInternal(host, {
        date: '2026-05-15',
        duration_minutes: 30,
        earliest: '00:00',
        latest: '23:59',
        count: 1,
      });
      // All-day events don't block intra-day time
      assert.ok(result.slots.length >= 1, 'all-day event should not block slots');
      assert.ok(result.warning, 'warning about all-day event should be set');
      assert.match(result.warning!, /all.day/i);
    } finally {
      globalThis.fetch = origFetch;
    }
    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('findFreeSlotsInternal: gap smaller than duration_minutes produces no slot from that gap', async () => {
  // Two events leave a 15-minute gap; asking for 30 minutes should skip it.
  // We use wide bounds (00:00-23:59) and place events mid-UTC-day so the
  // 15-min gap is inside the window on most timezones.
  const tmp = mkdtempSync(join(tmpdir(), 'ged-plan-gap-'));
  try {
    const db = open({ path: join(tmp, 'g.db') });
    const host = makeHost(db);
    // Two events with a 15-minute gap at UTC noon; outer window is 00:00-23:59.
    // On any timezone within ±11h of UTC, this gap is within the boundary.
    const evA = {
      id: 'ev-a',
      summary: 'Meeting A',
      start: { dateTime: '2026-05-15T11:00:00Z' },
      end: { dateTime: '2026-05-15T12:00:00Z' },
    };
    const evB = {
      id: 'ev-b',
      summary: 'Meeting B',
      start: { dateTime: '2026-05-15T12:15:00Z' },
      end: { dateTime: '2026-05-15T14:00:00Z' },
    };

    const origFetch = globalThis.fetch;
    globalThis.fetch = makeFetchMock([evA, evB]);
    try {
      const result = await findFreeSlotsInternal(host, {
        date: '2026-05-15',
        duration_minutes: 30,
        earliest: '00:00',
        latest: '23:59',
        count: 5,
      });
      // The 15-min gap between evA and evB should NOT appear as a slot.
      // Slots from before evA or after evB are fine to include.
      const gapStart = new Date('2026-05-15T12:00:00Z').getTime();
      const gapEnd = new Date('2026-05-15T12:15:00Z').getTime();
      const hasGapSlot = result.slots.some((s) => {
        const sStart = new Date(s.startIso).getTime();
        return sStart >= gapStart && sStart < gapEnd;
      });
      assert.ok(!hasGapSlot, '15-minute gap should not produce a 30-minute slot');
    } finally {
      globalThis.fetch = origFetch;
    }
    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('findFreeSlotsInternal: count limit is respected', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ged-plan-count-'));
  try {
    const db = open({ path: join(tmp, 'g.db') });
    const host = makeHost(db);
    const origFetch = globalThis.fetch;
    globalThis.fetch = makeFetchMock([]);
    try {
      const result = await findFreeSlotsInternal(host, {
        date: '2026-05-15',
        duration_minutes: 30,
        earliest: '00:00',
        latest: '23:59',
        count: 2,
      });
      assert.ok(result.slots.length <= 2, 'should return at most count slots');
    } finally {
      globalThis.fetch = origFetch;
    }
    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── smart_schedule_task tests ─────────────────────────────────────────────────

test('smart_schedule_task: schedules task and inserts smart_scheduled_links row', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ged-smart-'));
  try {
    const db = open({ path: join(tmp, 'g.db') });
    // Create the smart_scheduled_links table (normally created by migration 0002)
    db.prepare(
      `CREATE TABLE smart_scheduled_links (
         task_id TEXT NOT NULL,
         event_id TEXT NOT NULL,
         scheduled_at INTEGER NOT NULL,
         PRIMARY KEY (task_id, event_id)
       )`,
    ).run();

    const host = makeHost(db);
    const tools = registerTools(host);

    const origFetch = globalThis.fetch;
    // Serve: token × 2 (tasks + calendar), listTasks, listEvents (empty), addEvent
    let callIdx = 0;
    const responses = [
      { access_token: 'AT', expires_in: 3600 }, // token for tasks
      { items: [{ id: 'task-42', title: 'Write the report', status: 'needsAction' }] }, // listTasks
      { access_token: 'AT', expires_in: 3600 }, // token for calendar
      { items: [] }, // listEvents (empty → free slot)
      {
        id: 'new-ev-7',
        summary: 'Write the report',
        start: { dateTime: '2026-05-15T09:00:00Z' },
        end: { dateTime: '2026-05-15T09:30:00Z' },
      }, // addEvent
    ];
    globalThis.fetch = async (_input: RequestInfo | URL): Promise<Response> => {
      const resp = responses[callIdx++];
      if (resp === undefined) throw new Error(`fetch script exhausted at call ${callIdx}`);
      return mockJsonResponse(resp);
    };

    try {
      const invoke = tools.get('smart_schedule_task')!;
      const result = await invoke(
        {
          task_title: 'Write the report',
          date: '2026-05-15',
          earliest: '00:00',
          latest: '23:59',
        },
        { log: fakeLog },
      );

      // Result should mention the task title and scheduling
      assert.match(String(result), /Write the report/);
      assert.match(String(result), /Scheduled/i);

      // smart_scheduled_links row must be inserted
      const row = db
        .prepare(
          `SELECT task_id, event_id FROM smart_scheduled_links
           WHERE task_id='task-42' AND event_id='new-ev-7'`,
        )
        .get() as { task_id: string; event_id: string } | undefined;
      assert.ok(row, 'smart_scheduled_links row should be inserted');
      assert.equal(row!.task_id, 'task-42');
      assert.equal(row!.event_id, 'new-ev-7');
    } finally {
      globalThis.fetch = origFetch;
    }
    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('smart_schedule_task: returns error when no calendar configured', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ged-smart-nocal-'));
  try {
    const db = open({ path: join(tmp, 'g.db') });
    const noCredHost = {
      settings: { get: () => undefined, set: () => {} },
      db,
      telegram: { knownChats: () => [], defaultChatId: null },
    } as unknown as Host;
    const tools = registerTools(noCredHost);
    const invoke = tools.get('smart_schedule_task')!;
    const result = await invoke({ task_title: 'Do something' }, { log: fakeLog });
    assert.match(String(result), /not configured/i);
    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('smart_schedule_task: returns error when task title is missing', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ged-smart-notitle-'));
  try {
    const db = open({ path: join(tmp, 'g.db') });
    const host = makeHost(db);
    const tools = registerTools(host);
    const invoke = tools.get('smart_schedule_task')!;
    const result = await invoke({}, { log: fakeLog });
    assert.match(String(result), /task_title|task_id/i);
    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
