// Regression: owner-chat resolution must ignore the virtual chat ids that agent
// runs upsert into telegram_chats. Before the REAL_TELEGRAM_CHAT_SQL guard, a
// background agent run left a row newer than the owner's real DM, so ownerChat
// resolved to a phantom 7e12+ id and every proactive Telegram send died with
// "chat not found" (routine results AND briefings).

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open, type DB } from '../../storage/db.js';
import { createLogger } from '../../util/log.js';
import { AGENT_CHAT_ID_BASE, AGENT_DM_CHAT_ID_BASE } from '../../core/agents.js';
import type { ModulusConfig } from '../../cli/config-store.js';
import { ownerChat } from './chat.js';

const log = createLogger({ level: 'error', out: () => {}, err: () => {} });

function withDb(fn: (db: DB) => void): void {
  const home = mkdtempSync(join(tmpdir(), 'modulus-ownerchat-'));
  const db = open({ path: join(home, 'modulus.db'), log });
  try {
    fn(db);
  } finally {
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
}

function seedChat(db: DB, chatId: number, userId: number, lastSeenAt: number): void {
  db.prepare(`INSERT INTO telegram_chats (chat_id, user_id, last_seen_at) VALUES (?, ?, ?)`).run(
    chatId,
    userId,
    lastSeenAt,
  );
}

const cfg = (allowedIds: number[]): ModulusConfig =>
  ({ telegram: { allowedIds } }) as unknown as ModulusConfig;

test('ownerChat skips newer virtual agent chats and resolves the real Telegram DM', () => {
  withDb((db) => {
    const owner = 8282811846;
    seedChat(db, owner, owner, 1000); // real DM, seen first
    seedChat(db, AGENT_CHAT_ID_BASE + 4, owner, 2000); // a task run, newer
    seedChat(db, AGENT_DM_CHAT_ID_BASE + 3, owner, 3000); // an agent DM, newest
    assert.deepEqual(ownerChat(db, cfg([owner])), { chatId: owner, userId: owner });
  });
});

test('ownerChat falls back to the allowlisted id when only virtual chats exist', () => {
  withDb((db) => {
    const owner = 555;
    seedChat(db, AGENT_CHAT_ID_BASE + 1, owner, 5000);
    assert.deepEqual(ownerChat(db, cfg([owner])), { chatId: owner, userId: owner });
  });
});
