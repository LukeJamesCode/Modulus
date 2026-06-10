// Pairing manager over a local HTTP stub that plays the Telegram Bot API
// (getMe / getUpdates / sendMessage). We script the getUpdates batches so the
// assertions are deterministic: pairs on the code, ignores group + non-matching
// messages while still advancing the offset, expires, and surfaces a 409.

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { open as openDb, type DB } from '../storage/db.js';
import { createLogger } from '../util/log.js';
import { createPairingManager, type PairingManager } from './telegram-pairing.js';

const TOKEN = '123456:test-token';
const log = createLogger({ level: 'error' });

let home: string;
let db: DB;
let server: Server;
let apiBase: string;

// Scripted getUpdates batches, consumed one per poll; once empty, the stub
// returns no updates (with a small delay so the loop doesn't hot-spin). Each
// test resets this. The offsets the stub was polled with are recorded.
let updateBatches: Array<Array<Record<string, unknown>>> = [];
let pollOffsets: number[] = [];
let getUpdatesStatus = 200;

function resetStub(): void {
  updateBatches = [];
  pollOffsets = [];
  getUpdatesStatus = 200;
}

before(async () => {
  home = mkdtempSync(join(tmpdir(), 'modulus-pairing-'));
  db = openDb({ path: join(home, 'modulus.db'), log });
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (path.endsWith('/getMe')) {
      json(200, { ok: true, result: { first_name: 'TestBot', username: 'testbot' } });
      return;
    }
    if (path.endsWith('/getUpdates')) {
      if (getUpdatesStatus !== 200) {
        json(getUpdatesStatus, { ok: false });
        return;
      }
      pollOffsets.push(Number(url.searchParams.get('offset') ?? '0'));
      const batch = updateBatches.shift();
      if (batch) {
        json(200, { ok: true, result: batch });
      } else {
        // Nothing scripted left: respond empty after a short delay so an
        // expiry/409 loop doesn't spin tightly.
        setTimeout(() => json(200, { ok: true, result: [] }), 30);
      }
      return;
    }
    if (path.endsWith('/sendMessage')) {
      json(200, { ok: true });
      return;
    }
    json(404, { ok: false });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  apiBase = `http://127.0.0.1:${port}`;
});

after(() => {
  server.close();
  db.close();
  rmSync(home, { recursive: true, force: true });
});

function manager(ttlMs = 10 * 60_000): PairingManager {
  return createPairingManager({ db, log, apiBase, ttlMs });
}

async function waitFor(fn: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('start validates the token via getMe and returns a code + bot handle', async () => {
  resetStub();
  const m = manager();
  const r = await m.start(TOKEN);
  assert.equal(r.ok, true);
  assert.match(r.code ?? '', /^MOD-[A-Z2-9]{4}$/);
  assert.equal(r.botUser, '@testbot');
  assert.equal(m.status().state, 'waiting');
  m.stop();
});

test('pairs on the code, ignoring group + non-matching messages, advancing the offset', async () => {
  resetStub();
  const m = manager();
  const r = await m.start(TOKEN);
  const code = r.code!;
  // Batch 1: a group message (must be ignored) + a non-matching private msg.
  updateBatches.push([
    { update_id: 10, message: { text: code, chat: { id: -100, type: 'group' }, from: { id: 1 } } },
    {
      update_id: 11,
      message: { text: 'hello', chat: { id: 555, type: 'private' }, from: { id: 555 } },
    },
  ]);
  // Batch 2: the matching code, sent in lowercase to prove normalization.
  updateBatches.push([
    {
      update_id: 12,
      message: {
        text: code.toLowerCase(),
        chat: { id: 777, type: 'private' },
        from: { id: 777, first_name: 'Ada' },
      },
    },
  ]);
  await waitFor(() => m.status().state === 'paired');
  const s = m.status();
  assert.equal(s.userId, 777);
  assert.equal(s.firstName, 'Ada');
  // The second poll must have advanced past batch 1 (max update_id 11 → 12).
  assert.ok(pollOffsets.includes(12), `offset advanced to 12 (saw ${pollOffsets.join(',')})`);
  // The paired chat was seeded into telegram_chats for owner/nudge resolution.
  const row = db.prepare('SELECT user_id FROM telegram_chats WHERE chat_id = ?').get(777) as
    | { user_id: number }
    | undefined;
  assert.equal(row?.user_id, 777);
});

test('expires after the TTL', async () => {
  resetStub();
  const m = manager(60);
  await m.start(TOKEN);
  await waitFor(() => m.status().state === 'expired');
  assert.equal(m.status().state, 'expired');
});

test('surfaces a getUpdates 409 as an error state', async () => {
  resetStub();
  getUpdatesStatus = 409;
  const m = manager();
  await m.start(TOKEN);
  await waitFor(() => m.status().state === 'error');
  assert.match(m.status().error ?? '', /polling this bot/);
});

test('tryMatch pairs from the adapter transport', () => {
  resetStub();
  const m = manager();
  // start() spins a getUpdates loop too, but tryMatch is independent of it.
  return m.start(TOKEN).then((r) => {
    const code = r.code!;
    assert.equal(m.tryMatch('nope', { id: 9 }, 9), false);
    assert.equal(m.tryMatch(code, { id: 42, first_name: 'Bo' }, 42), true);
    assert.equal(m.status().state, 'paired');
    assert.equal(m.status().userId, 42);
    m.stop();
  });
});
