import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { open } from '../../../src/storage/db.js';
import {
  assertWithinBudget,
  localDay,
  recordCall,
  usageByEndpointToday,
  usageToday,
} from './budget.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationSql = readFileSync(join(here, '..', 'migrations', '0001_init.sql'), 'utf8');

function freshDb(): ReturnType<typeof open> {
  const tmp = mkdtempSync(join(tmpdir(), 'oai-budget-'));
  const db = open({ path: join(tmp, 'g.db') });
  db.exec(migrationSql);
  (db as unknown as { _tmp: string })._tmp = tmp;
  return db;
}

function cleanup(db: ReturnType<typeof open>): void {
  const tmp = (db as unknown as { _tmp: string })._tmp;
  db.close();
  rmSync(tmp, { recursive: true, force: true });
}

test('usage is bucketed by local day and endpoint alias', () => {
  const db = freshDb();
  try {
    const day = localDay(Date.UTC(2026, 4, 28, 12), 'UTC');
    recordCall(db, {
      day,
      endpointAlias: 'deepseek',
      source: 'llm',
      status: 'ok',
      promptTokens: 10,
      completionTokens: 5,
    });
    recordCall(db, {
      day,
      endpointAlias: 'groq',
      source: 'llm',
      status: 'ok',
      promptTokens: 1,
      completionTokens: 2,
    });
    const usage = usageToday(db, day, 'deepseek');
    assert.equal(usage.calls, 1);
    assert.equal(usage.totalTokens, 15);
    assert.deepEqual(
      usageByEndpointToday(db, day).map((row) => row.endpointAlias),
      ['deepseek', 'groq'],
    );
  } finally {
    cleanup(db);
  }
});

test('budget refusal counts ok and error rows but excludes denied rows', () => {
  const db = freshDb();
  try {
    const day = '2026-05-28';
    recordCall(db, { day, endpointAlias: 'deepseek', source: 'llm', status: 'ok' });
    recordCall(db, { day, endpointAlias: 'deepseek', source: 'llm', status: 'denied' });
    assert.throws(() =>
      assertWithinBudget(db, { day, endpointAlias: 'deepseek', dailyCallLimit: 1 }),
    );
    assert.doesNotThrow(() =>
      assertWithinBudget(db, { day, endpointAlias: 'groq', dailyCallLimit: 1 }),
    );
  } finally {
    cleanup(db);
  }
});
