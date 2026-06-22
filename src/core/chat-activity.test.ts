import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createChatActivityRegistry } from './chat-activity.js';

test('a started run is listed until its handle ends', () => {
  const reg = createChatActivityRegistry();
  assert.deepEqual(reg.list(), []);

  const h = reg.start({ chatId: 42, userId: 1, text: 'hello' });
  const live = reg.list();
  assert.equal(live.length, 1);
  assert.equal(live[0]!.chatId, 42);
  assert.equal(live[0]!.text, 'hello');
  assert.ok(live[0]!.startedAt > 0);

  h.end();
  assert.deepEqual(reg.list(), []);
});

test('concurrent runs get distinct ids and clear independently', () => {
  const reg = createChatActivityRegistry();
  const a = reg.start({ chatId: 1, userId: 1, text: 'a' });
  const b = reg.start({ chatId: 2, userId: 1, text: 'b' });
  const ids = new Set(reg.list().map((r) => r.id));
  assert.equal(ids.size, 2);

  a.end();
  const rest = reg.list();
  assert.equal(rest.length, 1);
  assert.equal(rest[0]!.chatId, 2);
  b.end();
  assert.deepEqual(reg.list(), []);
});

test('end() is idempotent', () => {
  const reg = createChatActivityRegistry();
  const h = reg.start({ chatId: 1, userId: 1, text: 'x' });
  h.end();
  h.end();
  assert.deepEqual(reg.list(), []);
});
