import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { open as openDb } from '../storage/db.js';
import { createLogger } from '../util/log.js';
import { createPrefsStore, formatWindow, parseDuration, parseWindow } from './prefs.js';

const log = createLogger({ level: 'error', out: () => {}, err: () => {} });

function freshDb(): { db: ReturnType<typeof openDb>; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'modulus-prefs-'));
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

test('parseWindow accepts HH:MM-HH:MM and H-H', () => {
  assert.deepEqual(parseWindow('22:00-07:00'), { start: 22 * 60, end: 7 * 60 });
  assert.deepEqual(parseWindow('9-17'), { start: 9 * 60, end: 17 * 60 });
  assert.equal(parseWindow('25:00-07:00'), null);
  assert.equal(parseWindow('not a window'), null);
});

test('parseDuration accepts s/m/h/d', () => {
  assert.equal(parseDuration('30s'), 30_000);
  assert.equal(parseDuration('15m'), 900_000);
  assert.equal(parseDuration('2h'), 7_200_000);
  assert.equal(parseDuration('1d'), 86_400_000);
  assert.equal(parseDuration('bogus'), null);
});

test('formatWindow round-trips parseWindow output', () => {
  assert.equal(formatWindow(22 * 60, 7 * 60), '22:00-07:00');
  assert.equal(formatWindow(null, 7 * 60), null);
});

test('isQuiet: paused snooze takes precedence', () => {
  const { db, cleanup } = freshDb();
  try {
    const prefs = createPrefsStore(db);
    const at = new Date(2026, 4, 1, 12, 0);
    prefs.setPausedUntil(1, at.getTime() + 60_000);
    assert.equal(prefs.isQuiet(1, at).quiet, true);
    assert.equal(prefs.isQuiet(1, at).reason, 'paused');
    // After expiry: not quiet anymore.
    const later = new Date(at.getTime() + 120_000);
    assert.equal(prefs.isQuiet(1, later).quiet, false);
  } finally {
    cleanup();
  }
});

test('isQuiet: daily window 09:00-17:00 catches midday only', () => {
  const { db, cleanup } = freshDb();
  try {
    const prefs = createPrefsStore(db);
    prefs.setQuietWindow(1, 9 * 60, 17 * 60);
    assert.equal(prefs.isQuiet(1, new Date(2026, 4, 1, 12, 0)).quiet, true);
    assert.equal(prefs.isQuiet(1, new Date(2026, 4, 1, 8, 59)).quiet, false);
    assert.equal(prefs.isQuiet(1, new Date(2026, 4, 1, 17, 0)).quiet, false);
  } finally {
    cleanup();
  }
});

test('isQuiet: wrap-midnight window 22:00-07:00 catches both ends', () => {
  const { db, cleanup } = freshDb();
  try {
    const prefs = createPrefsStore(db);
    prefs.setQuietWindow(1, 22 * 60, 7 * 60);
    assert.equal(prefs.isQuiet(1, new Date(2026, 4, 1, 23, 30)).quiet, true);
    assert.equal(prefs.isQuiet(1, new Date(2026, 4, 1, 6, 30)).quiet, true);
    assert.equal(prefs.isQuiet(1, new Date(2026, 4, 1, 12, 0)).quiet, false);
  } finally {
    cleanup();
  }
});

test('clear removes the row', () => {
  const { db, cleanup } = freshDb();
  try {
    const prefs = createPrefsStore(db);
    prefs.setQuietWindow(1, 9 * 60, 17 * 60);
    prefs.setPausedUntil(1, Date.now() + 60_000);
    prefs.clear(1);
    const p = prefs.get(1);
    assert.equal(p.quietStartMinute, null);
    assert.equal(p.quietEndMinute, null);
    assert.equal(p.pausedUntilMs, null);
  } finally {
    cleanup();
  }
});
