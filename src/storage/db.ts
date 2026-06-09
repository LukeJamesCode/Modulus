// SQLite + numbered migrations. better-sqlite3, sync API, WAL mode.
//
// Migrations live in src/storage/migrations/NNNN_name.sql. The runner records
// applied migrations in a `_migrations` table keyed by version number, runs
// each unapplied file in a transaction, and refuses to start if a previously
// applied migration has gone missing or changed (checksum mismatch).

import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from '../util/log.js';
import { ensurePrivateDir, ensurePrivateFile } from '../cli/config-store.js';

export type DB = Database.Database;

export interface OpenOptions {
  path: string;
  log?: Logger;
  // Override migration directory (tests).
  migrationsDir?: string;
}

export interface MigrateOptions {
  // Table that records applied versions. Defaults to `_migrations`. Per-
  // extension migrations pass a unique table (e.g. `_ext_calendar_migrations`)
  // so their version numbering doesn't collide with core's.
  table?: string;
}

export interface Migration {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

const MIGRATION_FILE_RE = /^(\d{4})_([a-z0-9_]+)\.sql$/i;

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MIGRATIONS_DIR = resolve(SELF_DIR, 'migrations');

export function open(opts: OpenOptions): DB {
  ensurePrivateDir(dirname(opts.path));
  const db = new Database(opts.path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  // Wait up to 5s for a held write lock instead of throwing SQLITE_BUSY
  // immediately. Under WAL the per-minute scheduler tick and a concurrent
  // user-turn write can briefly contend; without this, one of them fails the
  // whole operation rather than waiting out the (millisecond-scale) lock.
  db.pragma('busy_timeout = 5000');
  // Larger page cache and memory-mapped reads. Defaults (~2 MB cache, mmap
  // off) are tuned for tiny embedded targets; on any real host these cut disk
  // reads for hot tables (history, scheduler queue) at trivial cost. cache_size
  // is negative => KiB, so this is a 16 MB cache; mmap_size is virtual address
  // space, not committed RAM, so it's safe even on a 4 GB Pi.
  db.pragma('cache_size = -16000');
  db.pragma('mmap_size = 268435456');
  db.pragma('temp_store = MEMORY');
  ensureSqliteFilesPrivate(opts.path);
  migrate(db, opts.migrationsDir ?? DEFAULT_MIGRATIONS_DIR, opts.log);
  ensureSqliteFilesPrivate(opts.path);
  return db;
}

export function loadMigrations(dir: string): Migration[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const migrations: Migration[] = [];
  for (const file of entries) {
    const m = MIGRATION_FILE_RE.exec(file);
    if (!m) continue;
    const version = Number.parseInt(m[1]!, 10);
    const name = m[2]!;
    const sql = readFileSync(join(dir, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    migrations.push({ version, name, sql, checksum });
  }
  migrations.sort((a, b) => a.version - b.version);
  // Sanity: no duplicate versions.
  for (let i = 1; i < migrations.length; i++) {
    if (migrations[i]!.version === migrations[i - 1]!.version) {
      throw new Error(`duplicate migration version ${migrations[i]!.version}`);
    }
  }
  return migrations;
}

const TABLE_RE = /^[a-z_][a-z0-9_]*$/i;

export function migrate(db: DB, dir: string, log?: Logger, opts: MigrateOptions = {}): void {
  const table = opts.table ?? '_migrations';
  if (!TABLE_RE.test(table)) {
    throw new Error(`invalid migrations table name '${table}'`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${table} (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);

  const migrations = loadMigrations(dir);
  const applied = db
    .prepare(`SELECT version, name, checksum FROM ${table} ORDER BY version`)
    .all() as Array<{ version: number; name: string; checksum: string }>;

  // Verify already-applied migrations still match what's on disk.
  for (const a of applied) {
    const onDisk = migrations.find((m) => m.version === a.version);
    if (!onDisk) {
      throw new Error(`migration ${a.version} (${a.name}) was applied but is missing from ${dir}`);
    }
    if (onDisk.checksum !== a.checksum) {
      throw new Error(
        `migration ${a.version} (${a.name}) changed since it was applied (checksum mismatch)`,
      );
    }
  }

  const appliedVersions = new Set(applied.map((a) => a.version));
  const insert = db.prepare(
    `INSERT INTO ${table} (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)`,
  );
  for (const m of migrations) {
    if (appliedVersions.has(m.version)) continue;
    log?.info('applying migration', { version: m.version, name: m.name });
    db.transaction(() => {
      db.exec(m.sql);
      insert.run(m.version, m.name, m.checksum, Date.now());
    })();
  }
}

function ensureSqliteFilesPrivate(path: string): void {
  ensurePrivateFile(path);
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${path}${suffix}`;
    if (existsSync(sidecar)) ensurePrivateFile(sidecar);
  }
}
