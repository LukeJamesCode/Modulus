// Shared enable/disable/uninstall logic used by both the CLI (`modulus mod …`)
// and the in-process panel. These tests pin the contract both surfaces depend
// on: the DB flip is idempotent insert-or-update, uninstall only ever touches
// the user root (never a repo-bundled module), and purge clears persisted rows.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open as openDb, type DB } from '../storage/db.js';
import { createLogger } from '../util/log.js';
import {
  findInstalledModule,
  setModuleEnabledState,
  uninstallModuleFiles,
} from './module-admin.js';

const log = createLogger({ level: 'error', out: () => {}, err: () => {} });

function setup(): { home: string; db: DB } {
  const home = mkdtempSync(join(tmpdir(), 'modulus-admin-'));
  const folder = join(home, 'modules', 'demo-mod');
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, 'manifest.json'),
    JSON.stringify({ name: 'demo-mod', version: '1.0.0', modulus: '>=0.1.0' }),
  );
  const db = openDb({ path: join(home, 'modulus.db'), log });
  return { home, db };
}

function enabledOf(db: DB, name: string): number | undefined {
  const row = db.prepare(`SELECT enabled FROM module_state WHERE name = ?`).get(name) as
    | { enabled: number }
    | undefined;
  return row?.enabled;
}

test('setModuleEnabledState flips an installed module and is idempotent', () => {
  const { home, db } = setup();
  try {
    assert.equal(findInstalledModule(home, 'demo-mod')?.version, '1.0.0');

    const off = setModuleEnabledState(db, home, 'demo-mod', false);
    assert.equal(off.ok, true);
    assert.equal(enabledOf(db, 'demo-mod'), 0);

    const on = setModuleEnabledState(db, home, 'demo-mod', true);
    assert.equal(on.ok, true);
    assert.equal(enabledOf(db, 'demo-mod'), 1);
  } finally {
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('setModuleEnabledState refuses a module that is not installed', () => {
  const { home, db } = setup();
  try {
    const r = setModuleEnabledState(db, home, 'ghost-mod', true);
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /not installed/);
    assert.equal(enabledOf(db, 'ghost-mod'), undefined);
  } finally {
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('uninstallModuleFiles removes the user folder and (with purge) the rows', () => {
  const { home, db } = setup();
  try {
    setModuleEnabledState(db, home, 'demo-mod', true);
    db.prepare(
      `INSERT INTO module_settings (module, key, value, updated_at) VALUES (?, ?, ?, ?)`,
    ).run('demo-mod', 'k', 'v', Date.now());

    const r = uninstallModuleFiles(home, 'demo-mod', { purge: true, db });
    assert.equal(r.ok, true);
    assert.equal(existsSync(join(home, 'modules', 'demo-mod')), false);
    assert.equal(enabledOf(db, 'demo-mod'), undefined);
    const settings = db
      .prepare(`SELECT COUNT(*) AS n FROM module_settings WHERE module = ?`)
      .get('demo-mod') as { n: number };
    assert.equal(settings.n, 0);
  } finally {
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('uninstallModuleFiles without purge keeps persisted settings', () => {
  const { home, db } = setup();
  try {
    db.prepare(
      `INSERT INTO module_settings (module, key, value, updated_at) VALUES (?, ?, ?, ?)`,
    ).run('demo-mod', 'k', 'v', Date.now());
    const r = uninstallModuleFiles(home, 'demo-mod', { purge: false });
    assert.equal(r.ok, true);
    assert.equal(existsSync(join(home, 'modules', 'demo-mod')), false);
    const settings = db
      .prepare(`SELECT COUNT(*) AS n FROM module_settings WHERE module = ?`)
      .get('demo-mod') as { n: number };
    assert.equal(settings.n, 1, 'settings kept when not purging');
  } finally {
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('uninstallModuleFiles refuses when nothing is installed under the user root', () => {
  const { home, db } = setup();
  try {
    const r = uninstallModuleFiles(home, 'ghost-mod', { purge: false });
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /not installed under/);
  } finally {
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
});
