import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import Database from 'better-sqlite3';
import { localDay, usageToday, recordCall } from './budget.js';

test('localDay formats consistently', () => {
  const d = localDay(1704067200000, 'UTC'); // 2024-01-01T00:00:00Z
  assert.equal(d, '2024-01-01');
});

test('recordCall and usageToday correctly track usage', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE minimax_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      day TEXT NOT NULL,
      chat_id INTEGER,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      created_at INTEGER NOT NULL
    )
  `);

  const day = '2024-01-01';
  recordCall(db, {
    day,
    source: 'provider',
    status: 'ok',
    promptTokens: 100,
    completionTokens: 50,
  });
  recordCall(db, {
    day,
    source: 'provider',
    status: 'ok',
    promptTokens: 200,
    completionTokens: 100,
  });
  recordCall(db, { day, source: 'provider', status: 'denied' }); // Should be ignored in usage count

  const usage = usageToday(db, day);
  assert.equal(usage.calls, 2);
  assert.equal(usage.promptTokens, 300);
  assert.equal(usage.completionTokens, 150);
});
