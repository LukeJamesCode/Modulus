import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../../../src/storage/db.js';
import type { Host } from '../../../src/core/modules.js';
import { register as registerTasks } from './tasks.js';
import { register as registerReminders } from './reminders.js';
import { register as registerCalendar } from './calendar.js';

type ToolInvoke = (
  args: Record<string, unknown>,
  ctx: { chatId?: number; log: unknown; signal?: AbortSignal; userMessage?: string },
) => Promise<unknown>;

function registerTools(register: (host: Host) => void, host: Host): Map<string, ToolInvoke> {
  const handlers = new Map<string, ToolInvoke>();
  register({
    ...host,
    tools: {
      register(def: { name: string; invoke: ToolInvoke }) {
        handlers.set(def.name, def.invoke);
      },
    },
  } as unknown as Host);
  return handlers;
}

const fakeLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function makeHost(db: ReturnType<typeof open>): Host {
  const settings = new Map<string, string>([
    ['google_client_id', 'cid'],
    ['google_client_secret', 'csec'],
    ['google_refresh_token', 'rtok'],
    ['default_tasklist', '@default'],
  ]);
  return {
    settings: {
      get<T>(key: string, def?: T): T | undefined {
        return (settings.get(key) as T) ?? def;
      },
      set() {},
      all: () => Object.fromEntries(settings),
    },
    db,
    telegram: { chatId: 100, defaultChatId: 100, knownChats: () => [] },
  } as unknown as Host;
}

test('tasks_add omits due when the user did not name a deadline', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ged-hardening-task-'));
  try {
    const db = open({ path: join(tmp, 'g.db') });
    const host = makeHost(db);
    const tools = registerTools(registerTasks, host);
    const origFetch = globalThis.fetch;
    const bodies: Array<string | undefined> = [];
    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      bodies.push(typeof init?.body === 'string' ? init.body : undefined);
      const body =
        bodies.length === 1
          ? { access_token: 'AT', expires_in: 3600 }
          : { id: 't1', title: 'Buy milk', status: 'needsAction' };
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as Response;
    };
    try {
      const result = await tools.get('tasks_add')!({ title: 'Buy milk' }, { log: fakeLog });
      assert.match(String(result), /Added/i);
      const taskBody = JSON.parse(bodies[1]!) as Record<string, unknown>;
      assert.equal(taskBody['title'], 'Buy milk');
      assert.equal('due' in taskBody, false);
    } finally {
      globalThis.fetch = origFetch;
    }
    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('calendar_add_event defaults end when the model omits it (timed event = +1h)', async () => {
  // qwen3.5:0.8b/2b routinely call calendar_add_event without `end`. The
  // schema used to mark it required, so the validator rejected the call
  // before invoke ran and the event was never created. Now the tool fills
  // end = start + 1h so a single missed arg doesn't fail the whole turn.
  const tmp = mkdtempSync(join(tmpdir(), 'ged-hardening-cal-'));
  try {
    const db = open({ path: join(tmp, 'g.db') });
    const host = makeHost(db);
    const tools = registerTools(registerCalendar, host);
    const origFetch = globalThis.fetch;
    const bodies: Array<string | undefined> = [];
    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      bodies.push(typeof init?.body === 'string' ? init.body : undefined);
      const body =
        bodies.length === 1
          ? { access_token: 'AT', expires_in: 3600 }
          : {
              id: 'e1',
              summary: 'Camping',
              start: { dateTime: '2026-05-23T12:00:00-06:00' },
              end: { dateTime: '2026-05-23T13:00:00-06:00' },
            };
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as Response;
    };
    try {
      const result = await tools.get('calendar_add_event')!(
        { summary: 'Camping', start: '2026-05-23T12:00:00-06:00' },
        { log: fakeLog },
      );
      assert.match(String(result), /Added/i);
      const eventBody = JSON.parse(bodies[1]!) as Record<string, unknown>;
      const end = (eventBody['end'] as { dateTime?: string } | undefined)?.dateTime;
      assert.ok(end, 'end should have been filled in');
      // +1h from the start ISO above
      assert.equal(end, '2026-05-23T19:00:00.000Z');
    } finally {
      globalThis.fetch = origFetch;
    }
    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('calendar_add_event defaults end for all-day events (end = start)', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ged-hardening-cal-allday-'));
  try {
    const db = open({ path: join(tmp, 'g.db') });
    const host = makeHost(db);
    const tools = registerTools(registerCalendar, host);
    const origFetch = globalThis.fetch;
    const bodies: Array<string | undefined> = [];
    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      bodies.push(typeof init?.body === 'string' ? init.body : undefined);
      const body =
        bodies.length === 1
          ? { access_token: 'AT', expires_in: 3600 }
          : {
              id: 'e2',
              summary: 'Birthday',
              start: { date: '2026-05-25' },
              end: { date: '2026-05-25' },
            };
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as Response;
    };
    try {
      const result = await tools.get('calendar_add_event')!(
        { summary: 'Birthday', start: '2026-05-25', all_day: true },
        { log: fakeLog },
      );
      assert.match(String(result), /Added/i);
      const eventBody = JSON.parse(bodies[1]!) as Record<string, unknown>;
      const end = (eventBody['end'] as { date?: string } | undefined)?.date;
      // Google calendar's all-day end is exclusive: a single-day birthday on
      // 2026-05-25 posts as end=2026-05-26. The tool fills end=start=2026-05-25
      // and api/calendar.ts.addEvent advances it by a day for the wire format.
      assert.equal(end, '2026-05-26');
    } finally {
      globalThis.fetch = origFetch;
    }
    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('calendar_add_event rewrites the model start/end to match the user clock time', async () => {
  // qwen3.5:2b on "9pm to 10pm" routinely emits 20:00-21:00 or 09:00-10:00.
  // The verbatim am/pm tokens in the user message are deterministic ground
  // truth, so the tool overrides the model's ISO when they disagree.
  const tmp = mkdtempSync(join(tmpdir(), 'ged-hardening-clock-'));
  try {
    const db = open({ path: join(tmp, 'g.db') });
    const host = makeHost(db);
    const tools = registerTools(registerCalendar, host);
    const origFetch = globalThis.fetch;
    const bodies: Array<string | undefined> = [];
    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      bodies.push(typeof init?.body === 'string' ? init.body : undefined);
      const body =
        bodies.length === 1
          ? { access_token: 'AT', expires_in: 3600 }
          : {
              id: 'e3',
              summary: 'Eating pizza',
              start: { dateTime: '2026-05-30T21:00:00-06:00' },
              end: { dateTime: '2026-05-30T22:00:00-06:00' },
            };
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as Response;
    };
    try {
      await tools.get('calendar_add_event')!(
        {
          summary: 'Eating pizza',
          // Model produced 09:00 AM instead of 21:00 — see the screenshot
          // that motivated this fix.
          start: '2026-05-30T09:00:00-06:00',
          end: '2026-05-30T10:00:00-06:00',
        },
        {
          log: fakeLog,
          userMessage: 'Schedule an event for may 30th for eating pizza 9pm to 10pm',
        },
      );
      const eventBody = JSON.parse(bodies[1]!) as Record<string, unknown>;
      const start = (eventBody['start'] as { dateTime?: string } | undefined)?.dateTime;
      const end = (eventBody['end'] as { dateTime?: string } | undefined)?.dateTime;
      assert.equal(start, '2026-05-30T21:00:00-06:00');
      assert.equal(end, '2026-05-30T22:00:00-06:00');
    } finally {
      globalThis.fetch = origFetch;
    }
    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('calendar_add_event leaves the start alone when no am/pm in the user message', async () => {
  // Don't second-guess a 24h clock or vague "tomorrow morning" phrasing.
  const tmp = mkdtempSync(join(tmpdir(), 'ged-hardening-clock-noop-'));
  try {
    const db = open({ path: join(tmp, 'g.db') });
    const host = makeHost(db);
    const tools = registerTools(registerCalendar, host);
    const origFetch = globalThis.fetch;
    const bodies: Array<string | undefined> = [];
    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      bodies.push(typeof init?.body === 'string' ? init.body : undefined);
      const body =
        bodies.length === 1
          ? { access_token: 'AT', expires_in: 3600 }
          : {
              id: 'e4',
              summary: 'Standup',
              start: { dateTime: '2026-05-30T09:00:00-06:00' },
              end: { dateTime: '2026-05-30T10:00:00-06:00' },
            };
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as Response;
    };
    try {
      await tools.get('calendar_add_event')!(
        {
          summary: 'Standup',
          start: '2026-05-30T09:00:00-06:00',
          end: '2026-05-30T10:00:00-06:00',
        },
        { log: fakeLog, userMessage: 'Schedule a standup tomorrow morning' },
      );
      const eventBody = JSON.parse(bodies[1]!) as Record<string, unknown>;
      const start = (eventBody['start'] as { dateTime?: string } | undefined)?.dateTime;
      assert.equal(start, '2026-05-30T09:00:00-06:00');
    } finally {
      globalThis.fetch = origFetch;
    }
    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('calendar_list_events resolves `date` to that local day and replies without event_ids', async () => {
  // Bug: the small chat model defaulted to today instead of computing ISO
  // bounds for "june 16th", so the list returned today's events. The tool now
  // takes a plain YYYY-MM-DD `date` and computes the local-day window itself.
  const tmp = mkdtempSync(join(tmpdir(), 'ged-hardening-cal-date-'));
  try {
    const db = open({ path: join(tmp, 'g.db') });
    const host = makeHost(db);
    // Pin the zone so the computed bounds don't depend on the test machine.
    (host.settings as unknown as { get: <T>(k: string, d?: T) => T | undefined }).get = (<T>(
      key: string,
      def?: T,
    ) =>
      ((
        {
          google_client_id: 'cid',
          google_client_secret: 'csec',
          google_refresh_token: 'rtok',
          time_zone: 'America/Denver',
          calendar_id: 'primary',
        } as Record<string, unknown>
      )[key] as T) ?? def) as Host['settings']['get'];
    const tools = registerTools(registerCalendar, host);
    const origFetch = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      urls.push(String(input));
      const body =
        urls.length === 1
          ? { access_token: 'AT', expires_in: 3600 }
          : {
              items: [
                {
                  id: 'e1',
                  summary: 'EMR Test',
                  start: { dateTime: '2026-06-16T14:00:00-06:00' },
                  end: { dateTime: '2026-06-16T15:00:00-06:00' },
                },
              ],
            };
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as Response;
    };
    try {
      const result = String(
        await tools.get('calendar_list_events')!({ date: '2026-06-16' }, { log: fakeLog }),
      );
      // The window queried is June 16 local (MDT = UTC-6), not today.
      const listUrl = urls[1]!;
      assert.match(listUrl, /timeMin=2026-06-16T06/);
      assert.match(listUrl, /timeMax=2026-06-17T06/);
      // Self-replying output is user-facing prose — no internal id block.
      assert.match(result, /EMR Test/);
      assert.doesNotMatch(result, /event_ids/);
    } finally {
      globalThis.fetch = origFetch;
    }
    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('reminder_clear_all deletes all unfired reminders for the originating chat', async () => {
  // Before this tool existed, "get rid of all my reminders" forced the model
  // to chain reminder_list + repeated reminder_cancel — qwen3.5:2b just
  // hallucinated success after the list call and left every row intact.
  const tmp = mkdtempSync(join(tmpdir(), 'ged-hardening-clear-all-'));
  try {
    const db = open({ path: join(tmp, 'g.db') });
    db.prepare(
      `CREATE TABLE reminders (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         chat_id INTEGER NOT NULL,
         text TEXT NOT NULL,
         fire_at INTEGER NOT NULL,
         fired INTEGER NOT NULL DEFAULT 0,
         created_at INTEGER NOT NULL
       )`,
    ).run();
    const insert = db.prepare(
      `INSERT INTO reminders (chat_id, text, fire_at, fired, created_at) VALUES (?,?,?,?,?)`,
    );
    insert.run(111, 'email landlord', Date.now() + 60_000, 0, Date.now());
    insert.run(111, 'take vitamins', Date.now() + 120_000, 0, Date.now());
    insert.run(111, 'already fired', Date.now() - 60_000, 1, Date.now()); // preserved
    insert.run(222, 'other chat', Date.now() + 60_000, 0, Date.now()); // preserved
    const host = makeHost(db);
    const tools = registerTools(registerReminders, host);
    const result = await tools.get('reminder_clear_all')!({}, { chatId: 111, log: fakeLog });
    assert.match(String(result), /Cleared 2 reminders/);
    const remaining = db
      .prepare(`SELECT chat_id, fired FROM reminders ORDER BY id`)
      .all() as Array<{
      chat_id: number;
      fired: number;
    }>;
    assert.deepEqual(remaining, [
      { chat_id: 111, fired: 1 }, // fired row kept
      { chat_id: 222, fired: 0 }, // other chat kept
    ]);
    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('reminder_cancel is scoped to the originating chat', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ged-hardening-reminder-'));
  try {
    const db = open({ path: join(tmp, 'g.db') });
    db.prepare(
      `CREATE TABLE reminders (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         chat_id INTEGER NOT NULL,
         text TEXT NOT NULL,
         fire_at INTEGER NOT NULL,
         fired INTEGER NOT NULL DEFAULT 0,
         created_at INTEGER NOT NULL
       )`,
    ).run();
    db.prepare(`INSERT INTO reminders (chat_id, text, fire_at, created_at) VALUES (?,?,?,?)`).run(
      222,
      'private',
      Date.now() + 60_000,
      Date.now(),
    );
    const host = makeHost(db);
    const tools = registerTools(registerReminders, host);
    const result = await tools.get('reminder_cancel')!({ id: 1 }, { chatId: 111, log: fakeLog });
    assert.match(String(result), /not found/i);
    const row = db.prepare(`SELECT chat_id FROM reminders WHERE id=1`).get() as
      | { chat_id: number }
      | undefined;
    assert.equal(row?.chat_id, 222);
    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
