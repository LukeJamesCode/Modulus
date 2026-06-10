import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { open } from '../../../src/storage/db.js';
import { localDay, countToday, usageToday, recordCall, remainingToday } from './budget.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationSql = readFileSync(join(here, '..', 'migrations', '0001_codex_calls.sql'), 'utf8');

function freshDb(): ReturnType<typeof open> {
  const tmp = mkdtempSync(join(tmpdir(), 'codex-budget-'));
  const db = open({ path: join(tmp, 'g.db') });
  // Apply the migration the same way the real migration runner does
  // (db.exec handles multiple statements + comments).
  db.exec(migrationSql);
  // Stash the temp dir on the db object so the test can clean it up.
  (db as unknown as { _tmp: string })._tmp = tmp;
  return db;
}

function cleanup(db: ReturnType<typeof open>): void {
  const tmp = (db as unknown as { _tmp: string })._tmp;
  db.close();
  rmSync(tmp, { recursive: true, force: true });
}

test('localDay formats a stable YYYY-MM-DD bucket', () => {
  // 2026-05-28T12:00:00Z in UTC.
  const day = localDay(Date.UTC(2026, 4, 28, 12, 0, 0), 'UTC');
  assert.equal(day, '2026-05-28');
});

test('localDay respects the timezone for the midnight boundary', () => {
  // 2026-05-28T02:00:00Z is still 2026-05-27 in New York (UTC-4 in May).
  const ts = Date.UTC(2026, 4, 28, 2, 0, 0);
  assert.equal(localDay(ts, 'America/New_York'), '2026-05-27');
  assert.equal(localDay(ts, 'UTC'), '2026-05-28');
});

test('countToday counts ok+error but excludes denied', () => {
  const db = freshDb();
  try {
    const day = '2026-05-28';
    recordCall(db, { day, source: 'tool', status: 'ok' });
    recordCall(db, { day, source: 'tool', status: 'error' });
    recordCall(db, { day, source: 'command', status: 'denied' });
    assert.equal(countToday(db, day), 2);
    assert.equal(remainingToday(db, 5, day), 3);
  } finally {
    cleanup(db);
  }
});

test('usageToday sums tokens for counted calls', () => {
  const db = freshDb();
  try {
    const day = '2026-05-28';
    recordCall(db, { day, source: 'tool', status: 'ok', promptTokens: 10, completionTokens: 20 });
    recordCall(db, { day, source: 'tool', status: 'ok', promptTokens: 5, completionTokens: 7 });
    const u = usageToday(db, day);
    assert.equal(u.calls, 2);
    assert.equal(u.promptTokens, 15);
    assert.equal(u.completionTokens, 27);
  } finally {
    cleanup(db);
  }
});

test('a different day does not count against today', () => {
  const db = freshDb();
  try {
    recordCall(db, { day: '2026-05-27', source: 'tool', status: 'ok' });
    assert.equal(countToday(db, '2026-05-28'), 0);
  } finally {
    cleanup(db);
  }
});
