import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../../../src/storage/db.js';
import { recentTurns, conversationIdForChat, formatHistory, type HistoryTurn } from './history.js';

// open() runs the core migrations (conversations/messages/telegram_chats) for us.
function freshDb(): ReturnType<typeof open> {
  const tmp = mkdtempSync(join(tmpdir(), 'codex-history-'));
  const db = open({ path: join(tmp, 'g.db') });
  (db as unknown as { _tmp: string })._tmp = tmp;
  return db;
}

function cleanup(db: ReturnType<typeof open>): void {
  const tmp = (db as unknown as { _tmp: string })._tmp;
  db.close();
  rmSync(tmp, { recursive: true, force: true });
}

function seedConversation(db: ReturnType<typeof open>, chatId: number): number {
  const conv = db
    .prepare(`INSERT INTO conversations (telegram_chat_id, started_at) VALUES (?, ?)`)
    .run(chatId, Date.now());
  const conversationId = Number(conv.lastInsertRowid);
  db.prepare(
    `INSERT INTO telegram_chats (chat_id, user_id, current_conversation_id, last_seen_at)
     VALUES (?, ?, ?, ?)`,
  ).run(chatId, 1, conversationId, Date.now());
  return conversationId;
}

function addMessage(
  db: ReturnType<typeof open>,
  conversationId: number,
  role: string,
  content: string,
): void {
  db.prepare(
    `INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)`,
  ).run(conversationId, role, content, Date.now());
}

test('recentTurns returns user/assistant turns oldest-first, excluding tool/system', () => {
  const db = freshDb();
  try {
    const cid = seedConversation(db, 100);
    addMessage(db, cid, 'system', 'you are modulus');
    addMessage(db, cid, 'user', 'first');
    addMessage(db, cid, 'assistant', 'reply one');
    addMessage(db, cid, 'tool', '{"raw":true}');
    addMessage(db, cid, 'user', 'second');
    const turns = recentTurns(db, cid, 10);
    assert.deepEqual(
      turns.map((t) => `${t.role}:${t.content}`),
      ['user:first', 'assistant:reply one', 'user:second'],
    );
  } finally {
    cleanup(db);
  }
});

test('recentTurns caps to the most recent N turns', () => {
  const db = freshDb();
  try {
    const cid = seedConversation(db, 101);
    for (let i = 0; i < 10; i++) addMessage(db, cid, 'user', `m${i}`);
    const turns = recentTurns(db, cid, 3);
    assert.deepEqual(
      turns.map((t) => t.content),
      ['m7', 'm8', 'm9'],
    );
  } finally {
    cleanup(db);
  }
});

test('recentTurns returns nothing when maxTurns is 0', () => {
  const db = freshDb();
  try {
    const cid = seedConversation(db, 102);
    addMessage(db, cid, 'user', 'hi');
    assert.deepEqual(recentTurns(db, cid, 0), []);
  } finally {
    cleanup(db);
  }
});

test('conversationIdForChat maps a chat to its open conversation', () => {
  const db = freshDb();
  try {
    const cid = seedConversation(db, 103);
    assert.equal(conversationIdForChat(db, 103), cid);
    assert.equal(conversationIdForChat(db, 999), undefined);
  } finally {
    cleanup(db);
  }
});

test('formatHistory labels turns and renders chronologically', () => {
  const turns: HistoryTurn[] = [
    { role: 'user', content: 'how do I sort in python' },
    { role: 'assistant', content: 'use sorted()' },
  ];
  assert.equal(
    formatHistory(turns, { maxChars: 1000 }),
    'User: how do I sort in python\nModulus: use sorted()',
  );
});

test('formatHistory drops oldest turns to fit the char budget, keeping newest', () => {
  const turns: HistoryTurn[] = [
    { role: 'user', content: 'AAAA' },
    { role: 'assistant', content: 'BBBB' },
    { role: 'user', content: 'CCCC' },
  ];
  // Budget only fits the last line ("User: CCCC" = 10 chars).
  const out = formatHistory(turns, { maxChars: 12 });
  assert.equal(out, 'User: CCCC');
});

test('formatHistory skips a turn equal to the excluded task', () => {
  const turns: HistoryTurn[] = [
    { role: 'user', content: 'earlier question' },
    { role: 'user', content: 'write me a poem' },
  ];
  const out = formatHistory(turns, { maxChars: 1000, exclude: 'write me a poem' });
  assert.equal(out, 'User: earlier question');
});
