import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as ext from './ext.js';
import { open as openDb } from '../storage/db.js';
import { createLogger } from '../util/log.js';

function mkHome(): string {
  return mkdtempSync(join(tmpdir(), 'modulus-ext-cli-test-'));
}

function writeManifest(folder: string, name: string, version = '0.1.0'): void {
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, 'manifest.json'),
    JSON.stringify({ name, version, modulus: '>=0.1.0' }),
  );
}

function captureStdout(fn: () => Promise<void>): Promise<string> {
  const buf: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (s: unknown) => boolean }).write = (s: unknown) => {
    buf.push(typeof s === 'string' ? s : String(s));
    return true;
  };
  return fn()
    .then(() => buf.join(''))
    .finally(() => {
      process.stdout.write = orig;
    });
}

test('ext.install copies a local folder into ~/.modulus/modules/', async () => {
  const home = mkHome();
  const oldHome = process.env['MODULUS_HOME'];
  process.env['MODULUS_HOME'] = home;
  try {
    const src = join(home, 'src-ext');
    writeManifest(src, 'modulus-fake');
    writeFileSync(join(src, 'tools.ts'), '// fake');

    const out = await captureStdout(() => ext.install(src));
    assert.match(out, /Installed 'modulus-fake'/);
    const dest = join(home, 'modules', 'modulus-fake');
    assert.ok(existsSync(join(dest, 'manifest.json')));
    assert.ok(existsSync(join(dest, 'tools.ts')));
  } finally {
    if (oldHome === undefined) delete process.env['MODULUS_HOME'];
    else process.env['MODULUS_HOME'] = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('ext.list shows installed modules and their state', async () => {
  const home = mkHome();
  const oldHome = process.env['MODULUS_HOME'];
  process.env['MODULUS_HOME'] = home;
  try {
    writeManifest(join(home, 'modules', 'modulus-a'), 'modulus-a', '1.0.0');
    writeManifest(join(home, 'modules', 'modulus-b'), 'modulus-b', '2.0.0');

    // Open DB to apply migrations so module_state exists.
    const log = createLogger({ level: 'error', out: () => {}, err: () => {} });
    const db = openDb({ path: join(home, 'modulus.db'), log });
    db.prepare(
      `INSERT INTO module_state (name, version, enabled, installed_at, last_loaded_at)
       VALUES ('modulus-a', '1.0.0', 0, ?, ?)`,
    ).run(Date.now(), Date.now());
    db.close();

    const out = await captureStdout(() => ext.list());
    assert.match(out, /modulus-a@1\.0\.0\s+\[disabled\]/);
    assert.match(out, /next: modulus mod enable modulus-a/);
    assert.match(out, /modulus-b@2\.0\.0\s+\[ready\]/);
  } finally {
    if (oldHome === undefined) delete process.env['MODULUS_HOME'];
    else process.env['MODULUS_HOME'] = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('ext.enable / ext.disable flip module_state.enabled', async () => {
  const home = mkHome();
  const oldHome = process.env['MODULUS_HOME'];
  process.env['MODULUS_HOME'] = home;
  try {
    writeManifest(join(home, 'modules', 'modulus-x'), 'modulus-x', '0.1.0');

    await captureStdout(() => ext.disable('modulus-x'));
    let log = createLogger({ level: 'error', out: () => {}, err: () => {} });
    let db = openDb({ path: join(home, 'modulus.db'), log });
    let row = db.prepare(`SELECT enabled FROM module_state WHERE name = ?`).get('modulus-x') as
      | { enabled: number }
      | undefined;
    assert.equal(row?.enabled, 0);
    db.close();

    await captureStdout(() => ext.enable('modulus-x'));
    log = createLogger({ level: 'error', out: () => {}, err: () => {} });
    db = openDb({ path: join(home, 'modulus.db'), log });
    row = db.prepare(`SELECT enabled FROM module_state WHERE name = ?`).get('modulus-x') as
      | { enabled: number }
      | undefined;
    assert.equal(row?.enabled, 1);
    db.close();
  } finally {
    if (oldHome === undefined) delete process.env['MODULUS_HOME'];
    else process.env['MODULUS_HOME'] = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('ext.uninstall --purge drops settings and state rows', async () => {
  const home = mkHome();
  const oldHome = process.env['MODULUS_HOME'];
  process.env['MODULUS_HOME'] = home;
  try {
    const folder = join(home, 'modules', 'modulus-y');
    writeManifest(folder, 'modulus-y', '0.1.0');

    const log = createLogger({ level: 'error', out: () => {}, err: () => {} });
    const db = openDb({ path: join(home, 'modulus.db'), log });
    db.prepare(
      `INSERT INTO module_state (name, version, enabled, installed_at, last_loaded_at)
       VALUES ('modulus-y', '0.1.0', 1, ?, ?)`,
    ).run(Date.now(), Date.now());
    db.prepare(
      `INSERT INTO module_settings (module, key, value, updated_at) VALUES ('modulus-y', 'k', 'v', ?)`,
    ).run(Date.now());
    db.close();

    await captureStdout(() => ext.uninstall('modulus-y', { purge: true }));
    assert.equal(existsSync(folder), false);

    const log2 = createLogger({ level: 'error', out: () => {}, err: () => {} });
    const db2 = openDb({ path: join(home, 'modulus.db'), log: log2 });
    const stateRow = db2.prepare(`SELECT * FROM module_state WHERE name = ?`).get('modulus-y');
    const settingsRow = db2
      .prepare(`SELECT * FROM module_settings WHERE module = ?`)
      .get('modulus-y');
    assert.equal(stateRow, undefined);
    assert.equal(settingsRow, undefined);
    db2.close();
  } finally {
    if (oldHome === undefined) delete process.env['MODULUS_HOME'];
    else process.env['MODULUS_HOME'] = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('ext.reload touches manifests so the file watcher fires', async () => {
  const home = mkHome();
  const oldHome = process.env['MODULUS_HOME'];
  process.env['MODULUS_HOME'] = home;
  try {
    const folder = join(home, 'modules', 'modulus-z');
    writeManifest(folder, 'modulus-z', '0.1.0');
    const before = readFileSync(join(folder, 'manifest.json'), 'utf8');
    await captureStdout(() => ext.reload('modulus-z'));
    const after = readFileSync(join(folder, 'manifest.json'), 'utf8');
    assert.equal(before, after); // content unchanged, only mtime nudged
  } finally {
    if (oldHome === undefined) delete process.env['MODULUS_HOME'];
    else process.env['MODULUS_HOME'] = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('ext.create scaffolds a runnable starter module', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'modulus-ext-create-'));
  try {
    await captureStdout(() => ext.create('modulus-demo', parent));
    const dest = join(parent, 'modulus-demo');
    const manifest = JSON.parse(readFileSync(join(dest, 'manifest.json'), 'utf8')) as {
      name: string;
      version: string;
      modulus: string;
      entrypoints?: Record<string, string>;
      telegram_commands?: Array<{ command: string }>;
    };
    assert.equal(manifest.name, 'modulus-demo');
    assert.equal(manifest.version, '0.1.0');
    assert.equal(manifest.modulus, '>=0.1.0');
    assert.equal(manifest.entrypoints?.['tools'], './tools.ts');
    assert.equal(manifest.entrypoints?.['commands'], './commands.ts');
    assert.equal(manifest.telegram_commands?.[0]?.command, 'demo');
    assert.ok(existsSync(join(dest, 'tools.ts')));
    assert.ok(existsSync(join(dest, 'commands.ts')));
    assert.ok(existsSync(join(dest, 'settings.schema.json')));
    assert.ok(existsSync(join(dest, 'README.md')));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
