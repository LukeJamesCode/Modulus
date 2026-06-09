import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setupFollowups } from './followups.js';
import { createScheduler, type Nudge } from './scheduler.js';
import { createToolRegistry } from './tools.js';
import { open as openDb } from '../storage/db.js';
import { createLogger } from '../util/log.js';
import type { ToolCall } from './llm.js';

const log = createLogger({ level: 'error', out: () => {}, err: () => {} });

function fresh(): {
  db: ReturnType<typeof openDb>;
  scheduler: ReturnType<typeof createScheduler>;
  tools: ReturnType<typeof createToolRegistry>;
  sent: Nudge[];
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'modulus-followups-'));
  const db = openDb({ path: join(dir, 'g.db'), log });
  const sent: Nudge[] = [];
  const scheduler = createScheduler({ log, dispatch: (n) => void sent.push(n) });
  const tools = createToolRegistry({ log });
  return {
    db,
    scheduler,
    tools,
    sent,
    cleanup: () => {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function call(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `c_${Math.random().toString(36).slice(2, 8)}`, name, arguments: args };
}

test('schedule_followup tool stores a row and produces a confirmation', async () => {
  const { db, scheduler, tools, cleanup } = fresh();
  try {
    setupFollowups({ db, scheduler, tools, log, now: () => new Date('2026-05-04T12:00:00Z') });
    const handler = tools.get('schedule_followup');
    assert.ok(handler, 'tool should be registered');

    const result = await tools.execute(
      call('schedule_followup', {
        when_iso: '2026-05-04T17:00:00Z',
        topic: 'Take the chicken out',
      }),
      { log, chatId: 42 },
    );
    assert.equal(result.ok, true, result.output);
    assert.match(result.output, /Scheduled followup #\d+/);

    const rows = db.prepare(`SELECT chat_id, topic, fired_at FROM followups`).all() as Array<{
      chat_id: number;
      topic: string;
      fired_at: number | null;
    }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.chat_id, 42);
    assert.equal(rows[0]!.topic, 'Take the chicken out');
    assert.equal(rows[0]!.fired_at, null);
  } finally {
    cleanup();
  }
});

test('schedule_followup rejects past timestamps', async () => {
  const { db, scheduler, tools, cleanup } = fresh();
  try {
    setupFollowups({ db, scheduler, tools, log, now: () => new Date('2026-05-04T12:00:00Z') });
    const result = await tools.execute(
      call('schedule_followup', {
        when_iso: '2026-05-04T11:00:00Z',
        topic: 'oops',
      }),
      { log, chatId: 1 },
    );
    // Validation errors come back as `ok: false`. Confirm no row was written
    // either way so we can't accidentally schedule a past followup.
    const rows = db.prepare(`SELECT COUNT(*) AS n FROM followups`).get() as { n: number };
    assert.equal(rows.n, 0);
    assert.match(result.output, /past/);
  } finally {
    cleanup();
  }
});

test('schedule_followup rejects timestamps more than a year out', async () => {
  const { db, scheduler, tools, cleanup } = fresh();
  try {
    setupFollowups({ db, scheduler, tools, log, now: () => new Date('2026-05-04T12:00:00Z') });
    const result = await tools.execute(
      call('schedule_followup', {
        when_iso: '2030-01-01T00:00:00Z',
        topic: 'far future',
      }),
      { log, chatId: 1 },
    );
    assert.match(result.output, /year/);
  } finally {
    cleanup();
  }
});

test('schedule_followup rejects garbage timestamps with a useful error', async () => {
  const { db, scheduler, tools, cleanup } = fresh();
  try {
    setupFollowups({ db, scheduler, tools, log, now: () => new Date('2026-05-04T12:00:00Z') });
    const result = await tools.execute(
      call('schedule_followup', { when_iso: 'tomorrow morning', topic: 'x' }),
      { log, chatId: 1 },
    );
    // The tool should give a model-readable hint so the next round can
    // retry with a real ISO string instead of bouncing forever.
    assert.match(result.output, /ISO 8601/);
  } finally {
    cleanup();
  }
});

test('sweep fires due followups and marks them as fired', async () => {
  const { db, scheduler, tools, sent, cleanup } = fresh();
  try {
    let now = new Date('2026-05-04T12:00:00Z');
    const f = setupFollowups({ db, scheduler, tools, log, now: () => now });

    f.schedule({
      chatId: 7,
      dueAt: new Date('2026-05-04T12:30:00Z').getTime(),
      topic: 'reminder A',
    });
    f.schedule({
      chatId: 7,
      dueAt: new Date('2026-05-04T13:00:00Z').getTime(),
      topic: 'reminder B',
    });

    // Tick at 12:25 — nothing due yet.
    now = new Date('2026-05-04T12:25:00Z');
    await scheduler.tickAt(now);
    assert.equal(sent.length, 0);

    // Tick at 12:30 — A fires, B still pending. (12:30 also re-runs the
    // every-minute sweep, so the cron pattern matches.)
    now = new Date('2026-05-04T12:30:00Z');
    await scheduler.tickAt(now);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.chatId, 7);
    assert.equal(sent[0]!.text, 'reminder A');

    // Verify A is marked fired and B is not.
    const rows = db
      .prepare(`SELECT topic, fired_at FROM followups ORDER BY due_at`)
      .all() as Array<{ topic: string; fired_at: number | null }>;
    assert.equal(rows[0]!.topic, 'reminder A');
    assert.notEqual(rows[0]!.fired_at, null);
    assert.equal(rows[1]!.fired_at, null);

    // Tick at 13:00 — B fires.
    now = new Date('2026-05-04T13:00:00Z');
    await scheduler.tickAt(now);
    assert.equal(sent.length, 2);
    assert.equal(sent[1]!.text, 'reminder B');
  } finally {
    cleanup();
  }
});

test('a followup is only emitted once even if the sweep runs twice', async () => {
  const { db, scheduler, tools, sent, cleanup } = fresh();
  try {
    let now = new Date('2026-05-04T12:00:00Z');
    const f = setupFollowups({ db, scheduler, tools, log, now: () => now });
    f.schedule({
      chatId: 1,
      dueAt: new Date('2026-05-04T12:30:00Z').getTime(),
      topic: 'once',
    });

    now = new Date('2026-05-04T12:30:00Z');
    await scheduler.tickAt(now);
    // A second tick at the same minute would re-trigger the cron match. The
    // sweep filters on `fired_at IS NULL`, so the row should not re-fire.
    await scheduler.tickAt(now);
    assert.equal(sent.length, 1, 'fired_at gate must prevent double-fire');
    assert.ok(db.prepare(`SELECT 1 FROM followups WHERE id = 1`).get(), 'row still present');
  } finally {
    cleanup();
  }
});

test('listPending is ordered by due time and scoped to the chat', () => {
  const { db, scheduler, tools, cleanup } = fresh();
  try {
    const f = setupFollowups({
      db,
      scheduler,
      tools,
      log,
      now: () => new Date('2026-05-04T12:00:00Z'),
    });
    f.schedule({
      chatId: 7,
      dueAt: new Date('2026-05-04T14:00:00Z').getTime(),
      topic: 'later',
    });
    f.schedule({
      chatId: 8,
      dueAt: new Date('2026-05-04T12:15:00Z').getTime(),
      topic: 'other chat',
    });
    f.schedule({
      chatId: 7,
      dueAt: new Date('2026-05-04T12:30:00Z').getTime(),
      topic: 'first',
    });

    assert.deepEqual(
      f.listPending(7).map((r) => r.topic),
      ['first', 'later'],
    );
    assert.deepEqual(
      f.listPending(8).map((r) => r.topic),
      ['other chat'],
    );
  } finally {
    cleanup();
  }
});

test('cancel only removes pending followups for the matching chat', async () => {
  const { db, scheduler, tools, sent, cleanup } = fresh();
  try {
    let now = new Date('2026-05-04T12:00:00Z');
    const f = setupFollowups({ db, scheduler, tools, log, now: () => now });
    const sameChat = f.schedule({
      chatId: 7,
      dueAt: new Date('2026-05-04T12:30:00Z').getTime(),
      topic: 'same chat',
    });
    const otherChat = f.schedule({
      chatId: 8,
      dueAt: new Date('2026-05-04T12:30:00Z').getTime(),
      topic: 'other chat',
    });

    assert.equal(f.cancel(7, otherChat), false);
    assert.equal(f.cancel(7, sameChat), true);
    assert.equal(f.cancel(7, sameChat), false);

    now = new Date('2026-05-04T12:30:00Z');
    await scheduler.tickAt(now);
    assert.deepEqual(
      sent.map((n) => n.text),
      ['other chat'],
    );
    assert.deepEqual(
      f.listPending(7).map((r) => r.id),
      [],
    );
  } finally {
    cleanup();
  }
});

test('clearPending removes only this chat pending followups', () => {
  const { db, scheduler, tools, cleanup } = fresh();
  try {
    const f = setupFollowups({
      db,
      scheduler,
      tools,
      log,
      now: () => new Date('2026-05-04T12:00:00Z'),
    });
    f.schedule({ chatId: 7, dueAt: new Date('2026-05-04T12:30:00Z').getTime(), topic: 'a' });
    f.schedule({ chatId: 7, dueAt: new Date('2026-05-04T13:00:00Z').getTime(), topic: 'b' });
    f.schedule({ chatId: 8, dueAt: new Date('2026-05-04T12:30:00Z').getTime(), topic: 'c' });

    assert.equal(f.clearPending(7), 2);
    assert.equal(f.clearPending(7), 0);
    assert.deepEqual(
      f.listPending(8).map((r) => r.topic),
      ['c'],
    );
  } finally {
    cleanup();
  }
});
