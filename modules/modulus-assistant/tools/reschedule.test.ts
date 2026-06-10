// Reschedule lifecycle tests. Covers the DB-driven pieces (proposal creation,
// dedup, status transitions) and the migration's open-proposal unique index.
// The callback dispatch path is not exercised here — it requires a live
// Telegram adapter and is implicitly covered by typecheck + the manual flow.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, migrate } from '../../../src/storage/db.js';
import { openProposal } from './reschedule.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'migrations');

// Apply this module's migrations on top of the base schema that `open()`
// installs. Going through the real `migrate()` (rather than splitting on `;`)
// handles multi-statement scripts and string-literal semicolons safely.
function runExtMigrations(db: ReturnType<typeof open>): void {
  migrate(db, migrationsDir, undefined, { table: '_ext_test_migrations' });
}

// Windows occasionally holds SQLite WAL/SHM handles a moment after close()
// returns. Retry rmSync briefly so cleanup doesn't fail the test.
async function rmTempDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'ENOTEMPTY') throw e;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

function fixtureArgs(overrides: Partial<Parameters<typeof openProposal>[1]> = {}) {
  return {
    chatId: 42,
    eventId: 'evt-hike-001',
    eventSummary: 'Trail run',
    eventStart: '2026-06-01T10:00:00Z',
    eventEnd: '2026-06-01T11:00:00Z',
    reason: 'Heavy rain, 90% precip.',
    ...overrides,
  };
}

test('migration 0004 creates reschedule_proposals with the open-proposal unique index', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ged-resched-'));
  try {
    const db = open({ path: join(tmp, 'g.db') });
    runExtMigrations(db);
    const tableRow = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='reschedule_proposals'`)
      .get();
    assert.ok(tableRow, 'reschedule_proposals table should exist');
    const idxRow = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_reschedule_open'`)
      .get();
    assert.ok(idxRow, 'idx_reschedule_open should exist');
    db.close();
  } finally {
    await rmTempDir(tmp);
  }
});

test('openProposal creates a pending row and returns a Yes/No nudge', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ged-resched-create-'));
  try {
    const db = open({ path: join(tmp, 'g.db') });
    runExtMigrations(db);
    const result = openProposal(db, fixtureArgs());
    assert.ok(result, 'openProposal should return a result for a fresh event');
    const { proposalId, nudge } = result;
    assert.equal(nudge.chatId, 42);
    assert.match(nudge.text, /Weather alert/);
    assert.match(nudge.text, /Trail run/);
    assert.equal(nudge.actions?.length, 2, 'initial nudge must offer Yes and No');
    const cbs = (nudge.actions ?? []).map((a) => a.callbackData);
    assert.ok(cbs.includes(`cb:wxr:yes:${proposalId}`), 'Yes button targets the right proposal');
    assert.ok(cbs.includes(`cb:wxr:no:${proposalId}`), 'No button targets the right proposal');

    const row = db
      .prepare(`SELECT status, declined_slots_json FROM reschedule_proposals WHERE id=?`)
      .get(proposalId) as { status: string; declined_slots_json: string };
    assert.equal(row.status, 'pending');
    assert.equal(row.declined_slots_json, '[]');
    db.close();
  } finally {
    await rmTempDir(tmp);
  }
});

test('openProposal dedups: second call for the same open event returns null', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ged-resched-dedup-'));
  try {
    const db = open({ path: join(tmp, 'g.db') });
    runExtMigrations(db);
    const first = openProposal(db, fixtureArgs());
    assert.ok(first);
    const second = openProposal(db, fixtureArgs());
    assert.equal(second, null, 'second open proposal for same event should dedup');
    db.close();
  } finally {
    await rmTempDir(tmp);
  }
});

test('after a proposal is closed, a fresh proposal for the same event is allowed', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ged-resched-reopen-'));
  try {
    const db = open({ path: join(tmp, 'g.db') });
    runExtMigrations(db);
    const first = openProposal(db, fixtureArgs());
    assert.ok(first);
    // User said "no" — partial unique index drops out for status='rejected'.
    db.prepare(`UPDATE reschedule_proposals SET status='rejected' WHERE id=?`).run(
      first.proposalId,
    );
    const second = openProposal(db, fixtureArgs());
    assert.ok(second, 'closing the first proposal must free the slot for a new one');
    assert.notEqual(second.proposalId, first.proposalId);
    db.close();
  } finally {
    await rmTempDir(tmp);
  }
});

test('different chats get independent proposals for the same event_id', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ged-resched-chats-'));
  try {
    const db = open({ path: join(tmp, 'g.db') });
    runExtMigrations(db);
    const a = openProposal(db, fixtureArgs({ chatId: 1 }));
    const b = openProposal(db, fixtureArgs({ chatId: 2 }));
    assert.ok(a, 'chat 1 should get a proposal');
    assert.ok(b, 'chat 2 should get an independent proposal');
    assert.notEqual(a.proposalId, b.proposalId);
    db.close();
  } finally {
    await rmTempDir(tmp);
  }
});
