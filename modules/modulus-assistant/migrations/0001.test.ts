// 0001_init.sql creates the assistant's own tables (reminders,
// calendar_nudges_sent). The Gurney build also adopted settings from five older
// modules here; that step was dropped for Modulus (the source table was
// renamed and those modules never existed here), so this only checks the schema.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { open } from '../../../src/storage/db.js';

const here = dirname(fileURLToPath(import.meta.url));
const sql0001 = readFileSync(join(here, '0001_init.sql'), 'utf8');

function runMigration(db: ReturnType<typeof open>): void {
  // db.exec runs the whole multi-statement script (and tolerates comments),
  // which is how the loader's migration runner applies it.
  db.exec(sql0001);
}

function withDb(fn: (db: ReturnType<typeof open>) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'modulus-assistant-mig-'));
  const db = open({ path: join(dir, 'test.db') });
  try {
    fn(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function tableExists(db: ReturnType<typeof open>, name: string): boolean {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name);
}

test('creates the reminders and calendar_nudges_sent tables', () => {
  withDb((db) => {
    runMigration(db);
    assert.ok(tableExists(db, 'reminders'));
    assert.ok(tableExists(db, 'calendar_nudges_sent'));
  });
});

test('is idempotent: safe to run twice', () => {
  withDb((db) => {
    runMigration(db);
    assert.doesNotThrow(() => runMigration(db));
  });
});

test('pre-existing rows survive a re-run', () => {
  withDb((db) => {
    runMigration(db);
    db.prepare(
      `INSERT INTO reminders (chat_id, text, fire_at, fired, created_at) VALUES (1, 'call mum', 100, 0, 1)`,
    ).run();
    runMigration(db); // CREATE TABLE IF NOT EXISTS must not drop data
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM reminders`).get() as { n: number }).n;
    assert.equal(n, 1);
  });
});
