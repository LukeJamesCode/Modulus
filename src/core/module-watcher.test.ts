// Unit tests for the hot-reload watcher in isolation: drive createModuleWatcher
// with stub callbacks and a temp folder, asserting it detects real source edits,
// ignores node_modules churn, honors suspend/resume, and stops cleanly. The
// loader-level tests in modules.test.ts cover the integration; these pin the
// mechanism on its own.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../util/log.js';
import { createModuleWatcher, type ModuleWatcher } from './module-watcher.js';

const log = createLogger({ level: 'error', out: () => {}, err: () => {} });

function setup(): {
  root: string;
  folder: string;
  loads: string[];
  unloads: string[];
  reloads: number;
  watcher: ModuleWatcher;
} {
  const root = mkdtempSync(join(tmpdir(), 'modulus-watcher-'));
  const folder = join(root, 'demo');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'manifest.json'), '{"name":"demo","version":"1.0.0","modulus":"*"}');
  writeFileSync(join(folder, 'tools.js'), 'export function register() {}');

  const loads: string[] = [];
  const unloads: string[] = [];
  let reloads = 0;
  const loaded = new Set([folder]);
  const watcher = createModuleWatcher({
    log,
    roots: [root],
    isShuttingDown: () => false,
    loadModule: async (f) => {
      loads.push(f);
    },
    unloadModule: async (n) => {
      unloads.push(n);
      loaded.delete(folder);
    },
    onDidReload: () => {
      reloads += 1;
    },
    isFolderLoaded: (f) => loaded.has(f),
    nameForFolder: (f) => (f === folder ? 'demo' : undefined),
  });
  return {
    root,
    folder,
    loads,
    unloads,
    get reloads() {
      return reloads;
    },
    watcher,
  };
}

const settle = (ms = 600): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('watcher reloads on a real source change but ignores node_modules churn', async () => {
  const s = setup();
  try {
    s.watcher.watchModuleFolder('demo', s.folder);

    // node_modules churn (a simulated npm install) must not trigger a reload.
    for (let i = 0; i < 4; i++) {
      const pkg = join(s.folder, 'node_modules', `p${i}`);
      mkdirSync(pkg, { recursive: true });
      writeFileSync(join(pkg, 'index.js'), 'module.exports={}');
    }
    await settle();
    assert.equal(s.loads.length, 0, 'node_modules writes must not reload');

    // A real source edit reloads exactly once (debounced).
    writeFileSync(join(s.folder, 'tools.js'), 'export function register() { /* v2 */ }');
    await settle();
    assert.ok(s.loads.includes(s.folder), 'a source edit triggers loadModule');

    // The reload-leak counter records every reload that actually fired (one per
    // loadModule) and nothing for the node_modules churn that never reloaded.
    const counted = s.watcher.reloadCounts().demo ?? 0;
    assert.ok(counted >= 1, 'the reload is counted');
    assert.equal(counted, s.loads.length, 'counter matches the number of reloads performed');
  } finally {
    await s.watcher.stop();
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('watcher suspend blocks reloads; resume restores them', async () => {
  const s = setup();
  try {
    s.watcher.watchModuleFolder('demo', s.folder);

    s.watcher.suspend('demo');
    writeFileSync(join(s.folder, 'tools.js'), 'export function register() { /* a */ }');
    await settle();
    assert.equal(s.loads.length, 0, 'no reload while suspended');

    s.watcher.resume('demo');
    writeFileSync(join(s.folder, 'tools.js'), 'export function register() { /* b */ }');
    await settle();
    assert.ok(s.loads.length >= 1, 'reloads resume after resume()');
  } finally {
    await s.watcher.stop();
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('watcher detach stops a module from reloading further', async () => {
  const s = setup();
  try {
    s.watcher.watchModuleFolder('demo', s.folder);
    s.watcher.detach('demo');
    writeFileSync(join(s.folder, 'tools.js'), 'export function register() { /* c */ }');
    await settle();
    assert.equal(s.loads.length, 0, 'a detached module does not reload');
  } finally {
    await s.watcher.stop();
    rmSync(s.root, { recursive: true, force: true });
  }
});
