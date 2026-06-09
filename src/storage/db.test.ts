import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { chmodSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open, migrate, loadMigrations } from './db.js';
import Database from 'better-sqlite3';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'modulus-db-'));
}

test('open() applies the bundled init migration', () => {
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    assert.ok(names.includes('conversations'));
    assert.ok(names.includes('messages'));
    assert.ok(names.includes('telegram_chats'));
    assert.equal(names.includes('session_memory'), false);
    assert.equal(names.includes('scheduled_tasks'), false);
    assert.equal(names.includes('job_queue'), false);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('0007 migration drops unused core tables on existing databases', () => {
  const dir = tmp();
  const migDir = join(dir, 'migrations');
  mkdirSync(migDir);
  writeFileSync(
    join(migDir, '0001_init.sql'),
    [
      'CREATE TABLE session_memory (id INTEGER);',
      'CREATE TABLE scheduled_tasks (id INTEGER);',
      'CREATE TABLE job_queue (id INTEGER);',
    ].join('\n'),
  );
  writeFileSync(
    join(migDir, '0007_drop_unused_core_tables.sql'),
    [
      'DROP TABLE IF EXISTS scheduled_tasks;',
      'DROP TABLE IF EXISTS job_queue;',
      'DROP TABLE IF EXISTS session_memory;',
    ].join('\n'),
  );
  try {
    const db = new Database(join(dir, 'g.db'));
    migrate(db, migDir);
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    assert.equal(names.includes('session_memory'), false);
    assert.equal(names.includes('scheduled_tasks'), false);
    assert.equal(names.includes('job_queue'), false);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migrate() is idempotent', () => {
  const dir = tmp();
  const migDir = join(dir, 'migrations');
  mkdirSync(migDir);
  writeFileSync(join(migDir, '0001_a.sql'), 'CREATE TABLE a (id INTEGER PRIMARY KEY);');
  writeFileSync(join(migDir, '0002_b.sql'), 'CREATE TABLE b (id INTEGER PRIMARY KEY);');
  try {
    const db = new Database(join(dir, 'g.db'));
    migrate(db, migDir);
    migrate(db, migDir); // second call must be a no-op
    const applied = db.prepare('SELECT version FROM _migrations ORDER BY version').all() as Array<{
      version: number;
    }>;
    assert.deepEqual(
      applied.map((r) => r.version),
      [1, 2],
    );
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migrate() refuses to start if a previously applied migration changed', () => {
  const dir = tmp();
  const migDir = join(dir, 'migrations');
  mkdirSync(migDir);
  writeFileSync(join(migDir, '0001_a.sql'), 'CREATE TABLE a (id INTEGER PRIMARY KEY);');
  try {
    const db = new Database(join(dir, 'g.db'));
    migrate(db, migDir);
    writeFileSync(
      join(migDir, '0001_a.sql'),
      'CREATE TABLE a (id INTEGER PRIMARY KEY, x INTEGER);',
    );
    assert.throws(() => migrate(db, migDir), /checksum mismatch/);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadMigrations() rejects duplicate version numbers', () => {
  const dir = tmp();
  const migDir = join(dir, 'migrations');
  mkdirSync(migDir);
  writeFileSync(join(migDir, '0001_a.sql'), '-- a');
  writeFileSync(join(migDir, '0001_b.sql'), '-- b');
  try {
    assert.throws(() => loadMigrations(migDir), /duplicate migration version/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  'open() keeps database directory and files owner-only',
  { skip: process.platform === 'win32' ? 'POSIX mode bits are not reliable on Windows' : false },
  () => {
    const dir = tmp();
    try {
      chmodSync(dir, 0o777);
      const path = join(dir, 'g.db');
      const db = open({ path });
      assert.equal(statSync(dir).mode & 0o777, 0o700);
      assert.equal(statSync(path).mode & 0o777, 0o600);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
