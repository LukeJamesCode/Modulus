import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleQuiet } from './telegram.js';
import { createPrefsStore } from '../core/prefs.js';
import { open as openDb } from '../storage/db.js';
import { createLogger } from '../util/log.js';

const log = createLogger({ level: 'error', out: () => {}, err: () => {} });

function setup(): {
  prefs: ReturnType<typeof createPrefsStore>;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'modulus-quiet-'));
  const db = openDb({ path: join(dir, 'g.db'), log });
  return {
    prefs: createPrefsStore(db),
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('/quiet on then off toggles snooze', () => {
  const { prefs, cleanup } = setup();
  try {
    const at = new Date(2026, 4, 1, 12, 0);
    const r1 = handleQuiet(prefs, 1, 'on', () => at);
    assert.match(r1, /quiet on/);
    assert.equal(prefs.isQuiet(1, at).quiet, true);
    const r2 = handleQuiet(prefs, 1, 'off', () => at);
    assert.match(r2, /quiet off/);
    assert.equal(prefs.isQuiet(1, at).quiet, false);
  } finally {
    cleanup();
  }
});

test('/quiet 30m sets a finite snooze', () => {
  const { prefs, cleanup } = setup();
  try {
    const at = new Date(2026, 4, 1, 12, 0);
    handleQuiet(prefs, 1, '30m', () => at);
    assert.equal(prefs.isQuiet(1, at).quiet, true);
    const later = new Date(at.getTime() + 31 * 60_000);
    assert.equal(prefs.isQuiet(1, later).quiet, false);
  } finally {
    cleanup();
  }
});

test('/quiet 22:00-07:00 sets the daily window', () => {
  const { prefs, cleanup } = setup();
  try {
    const at = new Date(2026, 4, 1, 12, 0);
    const reply = handleQuiet(prefs, 1, '22:00-07:00', () => at);
    assert.match(reply, /22:00-07:00/);
    assert.equal(prefs.isQuiet(1, new Date(2026, 4, 1, 23, 0)).quiet, true);
    assert.equal(prefs.isQuiet(1, new Date(2026, 4, 1, 12, 0)).quiet, false);
  } finally {
    cleanup();
  }
});

test('/quiet with no arg shows current state', () => {
  const { prefs, cleanup } = setup();
  try {
    const at = new Date(2026, 4, 1, 12, 0);
    handleQuiet(prefs, 1, '22:00-07:00', () => at);
    const reply = handleQuiet(prefs, 1, '', () => at);
    assert.match(reply, /quiet: off/);
    assert.match(reply, /22:00-07:00/);
  } finally {
    cleanup();
  }
});

test('/quiet rejects garbage', () => {
  const { prefs, cleanup } = setup();
  try {
    const at = new Date(2026, 4, 1, 12, 0);
    const reply = handleQuiet(prefs, 1, 'banana', () => at);
    assert.match(reply, /Usage:/);
  } finally {
    cleanup();
  }
});
