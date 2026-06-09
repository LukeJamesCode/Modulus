import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createScheduler, type Nudge } from './scheduler.js';
import { createPrefsStore } from './prefs.js';
import { open as openDb } from '../storage/db.js';
import { createLogger } from '../util/log.js';

const log = createLogger({ level: 'error', out: () => {}, err: () => {} });

function freshDb(): { db: ReturnType<typeof openDb>; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'modulus-sched-'));
  const db = openDb({ path: join(dir, 'g.db'), log });
  return {
    db,
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

test('tickAt fires only matching jobs and routes nudges to dispatch', async () => {
  const sent: Nudge[] = [];
  const s = createScheduler({ log, dispatch: (n) => void sent.push(n) });
  let aFires = 0;
  let bFires = 0;
  s.register({
    extension: 'ext-a',
    name: 'a',
    cron: '0 9 * * *',
    handler: async () => {
      aFires++;
      return [{ chatId: 1, text: 'hello', key: 'a-2026-05-01' }];
    },
  });
  s.register({
    extension: 'ext-b',
    name: 'b',
    cron: '*/5 * * * *',
    handler: async () => {
      bFires++;
    },
  });
  // 09:00 — both fire
  await s.tickAt(new Date(2026, 4, 1, 9, 0));
  // 09:01 — neither fires
  await s.tickAt(new Date(2026, 4, 1, 9, 1));
  // 09:05 — only b fires
  await s.tickAt(new Date(2026, 4, 1, 9, 5));
  assert.equal(aFires, 1);
  assert.equal(bFires, 2);
  assert.equal(sent.length, 1);
});

test('nudge dedup: same key inside TTL is not re-dispatched', async () => {
  const sent: Nudge[] = [];
  const s = createScheduler({ log, dispatch: (n) => void sent.push(n) });
  s.register({
    extension: 'ext',
    name: 'sweep',
    cron: '*/5 * * * *',
    handler: async () => [{ chatId: 1, text: 'reminder', key: 'event-42' }],
  });
  await s.tickAt(new Date(2026, 4, 1, 9, 0));
  await s.tickAt(new Date(2026, 4, 1, 9, 5));
  await s.tickAt(new Date(2026, 4, 1, 9, 10));
  assert.equal(sent.length, 1, 'dedup key should suppress repeats');
});

test('long-running job does not block the next tick on a different job', async () => {
  const s = createScheduler({ log });
  let bFires = 0;
  let release!: () => void;
  const slow = new Promise<void>((r) => {
    release = r;
  });
  s.register({
    extension: 'a',
    name: 'slow',
    cron: '*/5 * * * *',
    handler: async () => {
      await slow;
    },
  });
  s.register({
    extension: 'b',
    name: 'fast',
    cron: '*/5 * * * *',
    handler: async () => {
      bFires++;
    },
  });
  const t1 = s.tickAt(new Date(2026, 4, 1, 9, 0));
  await s.tickAt(new Date(2026, 4, 1, 9, 5));
  // b fired once on the second tick even though a is still in flight.
  assert.equal(bFires, 1);
  release();
  await t1;
});

test('unregisterByExtension drops all of an extensions jobs', () => {
  const s = createScheduler({ log });
  s.register({
    extension: 'cal',
    name: 'sweep',
    cron: '*/5 * * * *',
    handler: async () => {},
  });
  s.register({
    extension: 'cal',
    name: 'daily',
    cron: '0 7 * * *',
    handler: async () => {},
  });
  s.register({
    extension: 'tasks',
    name: 'sweep',
    cron: '*/5 * * * *',
    handler: async () => {},
  });
  s.unregisterByExtension('cal');
  assert.deepEqual(
    s.list().map((j) => `${j.extension}:${j.name}`),
    ['tasks:sweep'],
  );
});

test('register throws on duplicate (extension, name)', () => {
  const s = createScheduler({ log });
  s.register({ extension: 'a', name: 'x', cron: '* * * * *', handler: async () => {} });
  assert.throws(() =>
    s.register({ extension: 'a', name: 'x', cron: '* * * * *', handler: async () => {} }),
  );
});

test('quiet hours suppress nudges and bump the dropped counter', async () => {
  const { db, cleanup } = freshDb();
  try {
    const sent: Nudge[] = [];
    const prefs = createPrefsStore(db);
    prefs.setQuietWindow(99, 9 * 60, 17 * 60); // 09:00-17:00
    const s = createScheduler({
      log,
      dispatch: (n) => void sent.push(n),
      prefs,
      db,
      now: () => new Date(2026, 4, 1, 12, 0),
    });
    s.register({
      extension: 'cal',
      name: 'sweep',
      cron: '*/5 * * * *',
      handler: async () => [{ chatId: 99, text: 'hi' }],
    });
    await s.tickAt(new Date(2026, 4, 1, 12, 0));
    assert.equal(sent.length, 0);
    assert.equal(s.stats().nudgesDropped.window, 1);
  } finally {
    cleanup();
  }
});

test('cross-extension rate limit caps nudges per chat per window', async () => {
  const { db, cleanup } = freshDb();
  try {
    const sent: Nudge[] = [];
    const s = createScheduler({
      log,
      dispatch: (n) => void sent.push(n),
      db,
      rateLimit: { max: 1, windowMs: 5 * 60_000 },
      now: () => new Date(2026, 4, 1, 12, 0),
    });
    s.register({
      extension: 'cal',
      name: 'a',
      cron: '*/1 * * * *',
      handler: async () => [{ chatId: 7, text: 'cal!' }],
    });
    s.register({
      extension: 'journal',
      name: 'b',
      cron: '*/1 * * * *',
      handler: async () => [{ chatId: 7, text: 'journal!' }],
    });
    s.register({
      extension: 'habits',
      name: 'c',
      cron: '*/1 * * * *',
      handler: async () => [{ chatId: 7, text: 'habits!' }],
    });
    await s.tickAt(new Date(2026, 4, 1, 12, 0));
    assert.equal(sent.length, 1, 'only one nudge fires under rate limit');
    assert.ok(s.stats().nudgesDropped.rate_limit >= 2);
  } finally {
    cleanup();
  }
});

test('dedup persists in nudge_log across scheduler instances', async () => {
  const { db, cleanup } = freshDb();
  try {
    const sentA: Nudge[] = [];
    const a = createScheduler({
      log,
      dispatch: (n) => void sentA.push(n),
      db,
      rateLimit: { max: 100, windowMs: 60_000 },
    });
    a.register({
      extension: 'cal',
      name: 'sweep',
      cron: '*/1 * * * *',
      handler: async () => [{ chatId: 1, text: 'r', key: 'event-42' }],
    });
    await a.tickAt(new Date(2026, 4, 1, 9, 0));
    assert.equal(sentA.length, 1);

    // New scheduler, same DB — the dedup key should still suppress.
    const sentB: Nudge[] = [];
    const b = createScheduler({
      log,
      dispatch: (n) => void sentB.push(n),
      db,
      rateLimit: { max: 100, windowMs: 60_000 },
    });
    b.register({
      extension: 'cal',
      name: 'sweep',
      cron: '*/1 * * * *',
      handler: async () => [{ chatId: 1, text: 'r', key: 'event-42' }],
    });
    await b.tickAt(new Date(2026, 4, 1, 9, 1));
    assert.equal(sentB.length, 0, 'dedup key from prior process suppresses re-fire');
    assert.equal(b.stats().nudgesDropped.dedup, 1);
  } finally {
    cleanup();
  }
});

test('scheduler persists nudge reason metadata in nudge_log', async () => {
  const { db, cleanup } = freshDb();
  try {
    const s = createScheduler({
      log,
      dispatch: () => {},
      db,
      rateLimit: { max: 100, windowMs: 60_000 },
      now: () => new Date('2026-05-09T12:00:00.000Z'),
    });
    s.register({
      extension: 'cal',
      name: 'sweep',
      cron: '* * * * *',
      handler: async () => [
        { chatId: 7, text: 'event soon', key: 'event-1', reason: 'event starts in 10 minutes' },
      ],
    });

    await s.tickAt(new Date('2026-05-09T12:00:00.000Z'));

    const row = db.prepare('SELECT reason FROM nudge_log WHERE chat_id = ?').get(7) as
      | { reason: string | null }
      | undefined;
    assert.equal(row?.reason, 'event starts in 10 minutes');
  } finally {
    cleanup();
  }
});

test('nudge metadata persists to nudge_log', async () => {
  const { db, cleanup } = freshDb();
  try {
    const s = createScheduler({
      log,
      dispatch: () => {},
      db,
      rateLimit: { max: 100, windowMs: 60_000 },
      now: () => new Date('2026-05-01T12:00:00.000Z'),
    });
    s.register({
      extension: 'cal',
      name: 'sweep',
      cron: '* * * * *',
      handler: async () => [
        {
          chatId: 42,
          text: 'event soon',
          key: 'event-99',
          priority: 'high',
          category: 'calendar',
          source: 'modulus-google-calendar',
          reason: 'Event starts in 5 minutes',
          createdAt: '2026-05-01T12:00:00.000Z',
          expiresAt: new Date('2026-05-01T12:05:00.000Z'),
          actions: [{ label: 'Open calendar', url: 'https://calendar.google.com' }],
        },
      ],
    });

    await s.tickAt(new Date('2026-05-01T12:00:00.000Z'));

    const row = db
      .prepare(
        `SELECT priority, category, source, reason, created_at AS createdAt,
                expires_at AS expiresAt, actions_json AS actionsJson
         FROM nudge_log WHERE key = ?`,
      )
      .get('event-99') as
      | {
          priority: string;
          category: string;
          source: string;
          reason: string;
          createdAt: number;
          expiresAt: number;
          actionsJson: string;
        }
      | undefined;

    assert.ok(row);
    assert.equal(row.priority, 'high');
    assert.equal(row.category, 'calendar');
    assert.equal(row.source, 'modulus-google-calendar');
    assert.equal(row.reason, 'Event starts in 5 minutes');
    assert.equal(row.createdAt, Date.parse('2026-05-01T12:00:00.000Z'));
    assert.equal(row.expiresAt, Date.parse('2026-05-01T12:05:00.000Z'));
    assert.deepEqual(JSON.parse(row.actionsJson), [
      { label: 'Open calendar', url: 'https://calendar.google.com' },
    ]);
  } finally {
    cleanup();
  }
});

test('cache stats are exposed via scheduler.stats()', async () => {
  const s = createScheduler({ log });
  s.cache.set('k', 1, 60_000);
  s.cache.get('k');
  s.cache.get('miss');
  const stats = s.stats();
  assert.equal(stats.cache.hits, 1);
  assert.equal(stats.cache.misses, 1);
  assert.equal(stats.cache.size, 1);
});

test('timezone-aware jobs match cron fields in their configured zone', async () => {
  const sent: Nudge[] = [];
  const s = createScheduler({ log, dispatch: (n) => void sent.push(n) });
  s.register({
    extension: 'briefing',
    name: 'morning',
    cron: '0 7 * * *',
    timeZone: 'America/Edmonton',
    handler: async () => [{ chatId: 1, text: 'morning' }],
  });

  await s.tickAt(new Date('2026-05-08T07:00:00Z'));
  assert.equal(sent.length, 0, '07:00 UTC is not 07:00 in Edmonton');

  await s.tickAt(new Date('2026-05-08T13:00:00Z'));
  assert.equal(sent.length, 1, '13:00 UTC is 07:00 MDT');
});

test('deferred nudge persists during quiet hours and sends when the window opens', async () => {
  const { db, cleanup } = freshDb();
  try {
    let current = new Date(2026, 4, 1, 12, 0);
    const sent: Nudge[] = [];
    const prefs = createPrefsStore(db);
    prefs.setQuietWindow(42, 9 * 60, 17 * 60);
    const s = createScheduler({
      log,
      dispatch: (n) => void sent.push(n),
      prefs,
      db,
      now: () => current,
      rateLimit: { max: 100, windowMs: 60_000 },
    });
    s.register({
      extension: 'cal',
      name: 'quiet-defer',
      cron: '0 12 * * *',
      handler: async () => [
        { chatId: 42, text: 'important', key: 'quiet-1', defer: true, priority: 'high' },
      ],
    });

    await s.tickAt(current);
    assert.equal(sent.length, 0);
    assert.equal(
      (db.prepare(`SELECT COUNT(*) AS n FROM deferred_nudges`).get() as { n: number }).n,
      1,
    );

    current = new Date(2026, 4, 1, 17, 0);
    await s.tickAt(current);
    assert.deepEqual(
      sent.map((n) => n.text),
      ['important'],
    );
    assert.equal(
      (
        db
          .prepare(`SELECT COUNT(*) AS n FROM deferred_nudges WHERE delivered_at IS NOT NULL`)
          .get() as { n: number }
      ).n,
      1,
    );
  } finally {
    cleanup();
  }
});

test('deferred nudge waits out the rate-limit window', async () => {
  const { db, cleanup } = freshDb();
  try {
    let current = new Date(2026, 4, 1, 12, 0);
    const sent: Nudge[] = [];
    const s = createScheduler({
      log,
      dispatch: (n) => void sent.push(n),
      db,
      now: () => current,
      rateLimit: { max: 1, windowMs: 5 * 60_000 },
    });
    db.prepare(
      `INSERT INTO nudge_log (chat_id, extension, job, key, sent_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(8, 'other', 'recent', null, current.getTime());
    s.register({
      extension: 'cal',
      name: 'rate-defer',
      cron: '0 12 * * *',
      handler: async () => [{ chatId: 8, text: 'after rate limit', key: 'rate-1', defer: true }],
    });

    await s.tickAt(current);
    assert.equal(sent.length, 0);
    const deferred = db
      .prepare(`SELECT not_before FROM deferred_nudges WHERE key = ?`)
      .get('rate-1') as { not_before: number };
    assert.equal(deferred.not_before, current.getTime() + 5 * 60_000);

    current = new Date(2026, 4, 1, 12, 5);
    await s.tickAt(current);
    assert.deepEqual(
      sent.map((n) => n.text),
      ['after rate limit'],
    );
  } finally {
    cleanup();
  }
});

test('expired deferred nudges are discarded instead of delivered', async () => {
  const { db, cleanup } = freshDb();
  try {
    let current = new Date(2026, 4, 1, 12, 0);
    const sent: Nudge[] = [];
    const prefs = createPrefsStore(db);
    prefs.setQuietWindow(51, 9 * 60, 17 * 60);
    const s = createScheduler({
      log,
      dispatch: (n) => void sent.push(n),
      prefs,
      db,
      now: () => current,
      rateLimit: { max: 100, windowMs: 60_000 },
    });
    s.register({
      extension: 'cal',
      name: 'expires',
      cron: '0 12 * * *',
      handler: async () => [
        {
          chatId: 51,
          text: 'too old',
          key: 'expires-1',
          defer: true,
          expiresAt: new Date(2026, 4, 1, 12, 30).getTime(),
        },
      ],
    });

    await s.tickAt(current);
    assert.equal(
      (db.prepare(`SELECT COUNT(*) AS n FROM deferred_nudges`).get() as { n: number }).n,
      1,
    );

    current = new Date(2026, 4, 1, 17, 0);
    await s.tickAt(current);
    assert.equal(sent.length, 0);
    assert.equal(
      (db.prepare(`SELECT COUNT(*) AS n FROM deferred_nudges`).get() as { n: number }).n,
      0,
    );
  } finally {
    cleanup();
  }
});

test('deferred nudge dedup keys keep only one pending row', async () => {
  const { db, cleanup } = freshDb();
  try {
    let current = new Date(2026, 4, 1, 12, 0);
    const sent: Nudge[] = [];
    const prefs = createPrefsStore(db);
    prefs.setQuietWindow(77, 9 * 60, 17 * 60);
    const s = createScheduler({
      log,
      dispatch: (n) => void sent.push(n),
      prefs,
      db,
      now: () => current,
      rateLimit: { max: 100, windowMs: 60_000 },
    });
    for (const name of ['a', 'b']) {
      s.register({
        extension: 'cal',
        name,
        cron: '0 12 * * *',
        handler: async () => [{ chatId: 77, text: `same ${name}`, key: 'same-key', defer: true }],
      });
    }

    await s.tickAt(current);
    assert.equal(
      (db.prepare(`SELECT COUNT(*) AS n FROM deferred_nudges`).get() as { n: number }).n,
      1,
    );

    current = new Date(2026, 4, 1, 17, 0);
    await s.tickAt(current);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.key, 'same-key');
  } finally {
    cleanup();
  }
});
