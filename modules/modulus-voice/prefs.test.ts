import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../../src/storage/db.js';
import { getPref, getSttPref, setBothPrefs, setPref, setSttPref, prepForSpeech } from './prefs.js';

function withDb<T>(fn: (db: ReturnType<typeof open>) => T): T {
  const tmp = mkdtempSync(join(tmpdir(), 'tts-prefs-'));
  const db = open({ path: join(tmp, 'g.db') });
  // Mirror the per-module migration; the smoke test exercises the real
  // migration path via the loader.
  // Mirror migrations 0001 + 0003: the row carries both TTS and STT flags so
  // `/voice on` (which writes both) can be exercised here.
  db.exec(
    `CREATE TABLE tts_chat_prefs (
       chat_id INTEGER PRIMARY KEY,
       enabled INTEGER NOT NULL,
       stt_enabled INTEGER NOT NULL DEFAULT 0,
       updated_at INTEGER NOT NULL
     );`,
  );
  try {
    return fn(db);
  } finally {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

test('getPref returns the configured fallback when no row exists', () => {
  withDb((db) => {
    assert.equal(getPref(db, 1, false), false);
    assert.equal(getPref(db, 1, true), true);
  });
});

test('setPref upserts and getPref reads it back', () => {
  withDb((db) => {
    setPref(db, 42, true);
    assert.equal(getPref(db, 42, false), true);
    setPref(db, 42, false);
    assert.equal(getPref(db, 42, true), false);
  });
});

test('setBothPrefs flips TTS and STT together so /voice on enables a full two-way flow', () => {
  withDb((db) => {
    setBothPrefs(db, 7, true);
    assert.equal(getPref(db, 7, false), true, 'tts pref should be on');
    assert.equal(getSttPref(db, 7, false), true, 'stt pref should be on');
    setBothPrefs(db, 7, false);
    assert.equal(getPref(db, 7, true), false, 'tts pref should flip off');
    assert.equal(getSttPref(db, 7, true), false, 'stt pref should flip off');
  });
});

test('setBothPrefs does not stomp a prior setSttPref-only row when called fresh', () => {
  // Order independence: a user who ran /voice transcribe on first and then
  // /voice on should still have both flags on after the second command.
  withDb((db) => {
    setSttPref(db, 9, true);
    setPref(db, 9, true);
    setBothPrefs(db, 9, true);
    assert.equal(getPref(db, 9, false), true);
    assert.equal(getSttPref(db, 9, false), true);
  });
});

test('prepForSpeech strips fenced code blocks', () => {
  const out = prepForSpeech('Hello.\n\n```\nlet x = 1\n```\n\nDone.', 600);
  assert.match(out!, /Hello\./);
  assert.match(out!, /code omitted/);
  assert.match(out!, /Done\./);
});

test('prepForSpeech strips inline code and Markdown emphasis', () => {
  const out = prepForSpeech('Run `npm test` to see *all* the **tests** ~now~.', 600);
  assert.equal(out, 'Run npm test to see all the tests now.');
});

test('prepForSpeech returns null for empty or oversized input', () => {
  assert.equal(prepForSpeech('   ', 600), null);
  assert.equal(prepForSpeech('a'.repeat(700), 600), null);
});
