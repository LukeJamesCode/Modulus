// Regression: if a migration's SQL throws, subsequent migrations must not
// run, and the failed migration must not appear in _migrations. The runner
// wraps each migration in db.transaction(...) and that transaction re-throws,
// which propagates out of migrate(). We pin that behaviour with a test so a
// future refactor can't silently introduce continue-on-error.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from './db.js';

test('migrate aborts on a failing migration and does not apply later ones', () => {
  const dir = mkdtempSync(join(tmpdir(), 'modulus-mig-'));
  try {
    const migrationsDir = join(dir, 'migrations');
    mkdirSync(migrationsDir);
    // 0001: deliberately invalid SQL → throws inside db.exec.
    writeFileSync(join(migrationsDir, '0001_broken.sql'), 'NOT VALID SQL STATEMENT;');
    // 0002: would create a real table if it ever ran.
    writeFileSync(
      join(migrationsDir, '0002_after.sql'),
      'CREATE TABLE should_not_exist (id INTEGER);',
    );

    const db = new Database(join(dir, 'g.db'));
    assert.throws(() => migrate(db, migrationsDir));

    // _migrations exists but is empty — neither version was recorded.
    const applied = db.prepare(`SELECT version FROM _migrations ORDER BY version`).all() as Array<{
      version: number;
    }>;
    assert.deepEqual(applied, []);

    // 0002's table is absent: the runner stopped at the first failure.
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='should_not_exist'`)
      .all();
    assert.deepEqual(tables, []);

    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
