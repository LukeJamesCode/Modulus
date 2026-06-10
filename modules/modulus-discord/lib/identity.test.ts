import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createIdentityStore,
  isDiscordChatId,
  DISCORD_CHAT_ID_BASE,
  DISCORD_CHAT_ID_MIN_BOUND,
} from './identity.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  const sql = readFileSync(join(__dirname, '..', 'migrations', '0001_init.sql'), 'utf8');
  db.exec(sql);
  return db;
}

test('isDiscordChatId: claims its own namespace, refuses Telegram IDs', () => {
  // Positive (Telegram user ids) and zero are NOT ours.
  assert.equal(isDiscordChatId(0), false);
  assert.equal(isDiscordChatId(123_456_789), false);
  // Negative Telegram supergroup ids are NOT ours.
  assert.equal(isDiscordChatId(-1_001_234_567_890_123), false);
  // Telegram basic-group ids (small negatives) are NOT ours.
  assert.equal(isDiscordChatId(-1), false);
  assert.equal(isDiscordChatId(-100), false);
  // Inside our window IS ours.
  assert.equal(isDiscordChatId(DISCORD_CHAT_ID_BASE), true);
  assert.equal(isDiscordChatId(DISCORD_CHAT_ID_BASE - 1), true);
  assert.equal(isDiscordChatId(DISCORD_CHAT_ID_MIN_BOUND), true);
  // Below the floor is NOT ours.
  assert.equal(isDiscordChatId(DISCORD_CHAT_ID_MIN_BOUND - 1), false);
});

test('identity: chatIdFor is stable across calls for the same pair', () => {
  const db = freshDb();
  const store = createIdentityStore(db);
  const first = store.chatIdFor({ userId: 'u-1', channelId: 'c-1', isDm: true });
  const second = store.chatIdFor({ userId: 'u-1', channelId: 'c-1', isDm: true });
  assert.equal(first, second);
  assert.equal(store.count(), 1);
});

test('identity: chatIdFor returns distinct IDs for distinct pairs', () => {
  const db = freshDb();
  const store = createIdentityStore(db);
  const a = store.chatIdFor({ userId: 'u-1', channelId: 'c-1', isDm: true });
  const b = store.chatIdFor({ userId: 'u-2', channelId: 'c-1', isDm: false });
  const c = store.chatIdFor({ userId: 'u-1', channelId: 'c-2', isDm: false });
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  assert.notEqual(b, c);
  assert.equal(store.count(), 3);
});

test('identity: every assigned ID is inside the namespace', () => {
  const db = freshDb();
  const store = createIdentityStore(db);
  for (let i = 0; i < 50; i++) {
    const id = store.chatIdFor({ userId: `u-${i}`, channelId: `c-${i}`, isDm: false });
    assert.ok(isDiscordChatId(id), `id ${id} for u-${i}/c-${i} not in Discord namespace`);
  }
});

test('identity: resolve returns the original pair for a known chatId', () => {
  const db = freshDb();
  const store = createIdentityStore(db);
  const id = store.chatIdFor({ userId: 'u-99', channelId: 'c-99', isDm: true });
  const row = store.resolve(id);
  assert.ok(row);
  assert.equal(row!.discordUserId, 'u-99');
  assert.equal(row!.discordChannelId, 'c-99');
  assert.equal(row!.isDm, true);
});

test('identity: resolve returns null for IDs outside the namespace', () => {
  const db = freshDb();
  const store = createIdentityStore(db);
  // A Telegram-shaped positive ID is never ours.
  assert.equal(store.resolve(12345), null);
  // A random in-namespace ID that we never assigned is also null.
  assert.equal(store.resolve(DISCORD_CHAT_ID_BASE - 999_999), null);
});
