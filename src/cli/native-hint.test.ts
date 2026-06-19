import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { betterSqliteHint } from './native-hint.js';

test('hints on a NODE_MODULE_VERSION mismatch for better-sqlite3', () => {
  const err =
    'The module better_sqlite3.node was compiled against a different Node.js version using NODE_MODULE_VERSION 115.';
  const hint = betterSqliteHint(err);
  assert.ok(hint);
  assert.match(hint!, /could not load a native binary/i);
  assert.match(hint!, /npm rebuild better-sqlite3/);
});

test('hints on a missing bindings file', () => {
  const hint = betterSqliteHint('Could not locate the bindings file. Tried: …/better_sqlite3.node');
  assert.ok(hint);
});

test('hints when better-sqlite3 is not installed at all', () => {
  assert.ok(betterSqliteHint("Cannot find module 'better-sqlite3'"));
});

test('hints on a wrong-arch ELF header (x64 binary on arm64)', () => {
  assert.ok(betterSqliteHint('Error loading better-sqlite3: invalid ELF header'));
});

test('returns null for unrelated errors', () => {
  assert.equal(betterSqliteHint('Telegram token is invalid'), null);
  assert.equal(betterSqliteHint('ECONNREFUSED 127.0.0.1:11434'), null);
  // A generic .node error that does not mention better-sqlite3 stays unhinted.
  assert.equal(betterSqliteHint('failed to load addon some_other.node'), null);
});
