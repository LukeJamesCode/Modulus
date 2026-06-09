import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPrefsStore } from '../core/prefs.js';
import { open as openDb } from '../storage/db.js';
import { createLogger } from '../util/log.js';
import { formatProactiveText, handleNudges, handleWhy } from './telegram.js';

const log = createLogger({ level: 'error', out: () => {}, err: () => {} });

function setup(): { db: ReturnType<typeof openDb>; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'modulus-telegram-proactive-'));
  const db = openDb({ path: join(dir, 'g.db'), log });
  return {
    db,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('/proactive formats scheduler jobs and quiet state', () => {
  const { db, cleanup } = setup();
  try {
    const prefs = createPrefsStore(db);
    prefs.setQuietWindow(42, 22 * 60, 7 * 60);
    const text = formatProactiveText(
      [
        { extension: 'modulus-google-calendar', name: 'event-reminders', cron: '*/5 * * * *' },
        { extension: 'followups', name: 'sweep', cron: '* * * * *' },
      ],
      prefs,
      42,
      () => new Date('2026-05-09T12:00:00.000Z'),
    );

    assert.match(text, /Proactive scheduler:/);
    assert.match(text, /jobs: 2/);
    assert.match(text, /modulus-google-calendar:event-reminders — \*\/5 \* \* \* \*/);
    assert.match(text, /followups:sweep — \* \* \* \* \*/);
    assert.match(text, /quiet: off/);
    assert.match(text, /daily window: 22:00-07:00/);
  } finally {
    cleanup();
  }
});

test('/nudges filters recent nudge history by current chat id', () => {
  const { db, cleanup } = setup();
  try {
    db.prepare(
      `INSERT INTO nudge_log (chat_id, extension, job, key, reason, sent_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(1, 'cal', 'sweep', 'event-1', 'event starts soon', Date.parse('2026-05-09T10:00:00Z'));
    db.prepare(
      `INSERT INTO nudge_log (chat_id, extension, job, key, reason, sent_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(2, 'tasks', 'sweep', 'task-1', 'task due', Date.parse('2026-05-09T11:00:00Z'));
    db.prepare(
      `INSERT INTO nudge_log (chat_id, extension, job, key, reason, sent_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(1, 'habits', 'daily', null, null, Date.parse('2026-05-09T12:00:00Z'));

    const text = handleNudges(db, 1, 5);

    assert.match(text, /Recent nudges:/);
    assert.match(text, /2026-05-09T12:00:00.000Z habits:daily/);
    assert.match(text, /2026-05-09T10:00:00.000Z cal:sweep key=event-1 — event starts soon/);
    assert.doesNotMatch(text, /tasks:sweep/);
    assert.doesNotMatch(text, /task due/);
  } finally {
    cleanup();
  }
});

test('/why shows most recent nudge explanation for current chat id only', () => {
  const { db, cleanup } = setup();
  try {
    db.prepare(
      `INSERT INTO nudge_log (chat_id, extension, job, key, reason, sent_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(9, 'cal', 'old', 'old-key', 'old reason', Date.parse('2026-05-09T09:00:00Z'));
    db.prepare(
      `INSERT INTO nudge_log (chat_id, extension, job, key, reason, sent_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(10, 'other', 'newer', 'other-key', 'wrong chat', Date.parse('2026-05-09T13:00:00Z'));
    db.prepare(
      `INSERT INTO nudge_log (chat_id, extension, job, key, reason, sent_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      9,
      'followups',
      'sweep',
      'followup-7',
      'you asked me to remind you',
      Date.parse('2026-05-09T12:00:00Z'),
    );

    const text = handleWhy(db, 9);

    assert.match(text, /Most recent nudge:/);
    assert.match(text, /extension: followups/);
    assert.match(text, /job: sweep/);
    assert.match(text, /key: followup-7/);
    assert.match(text, /sent_at: 2026-05-09T12:00:00.000Z/);
    assert.match(text, /reason: you asked me to remind you/);
    assert.doesNotMatch(text, /wrong chat/);
  } finally {
    cleanup();
  }
});
