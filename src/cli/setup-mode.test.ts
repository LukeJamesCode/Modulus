// Setup-mode server: boots the real panel against stub engine handles and
// asserts the wizard's contract. /api/state reports setupMode + not-configured,
// the module list works, /api/setup/complete preflights then resolves promotion
// (for both a full Telegram config and a panel-only one), an incomplete Telegram
// config is rejected, and the ollama pull SSE relays NDJSON progress.

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { saveConfig, effectiveConfig } from './config-store.js';
import { startSetupServer, type SetupServer } from './setup-mode.js';

const TOKEN_SECRET = 'AAHverylongfaketokensecretvalue1234567890';

// effectiveConfig overlays TELEGRAM_*/OLLAMA_* env; clear them so the suite is
// hermetic on a dev box that has them exported.
const SAVED: Record<string, string | undefined> = {};
const ENV_KEYS = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALLOWED_IDS', 'OLLAMA_URL', 'MODULUS_CHAT_MODEL'];

let home: string;
let server: SetupServer;
let base: string;
let token: string;
let ollama: Server;
let ollamaUrl: string;

function authed(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), 'x-modulus-token': token },
  });
}

before(async () => {
  for (const k of ENV_KEYS) {
    SAVED[k] = process.env[k];
    delete process.env[k];
  }
  home = mkdtempSync(join(tmpdir(), 'modulus-setup-'));

  // A stub Ollama that streams three progress lines + success for /api/pull.
  ollama = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/pull') {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write('{"status":"pulling manifest"}\n');
      res.write('{"status":"downloading","total":100,"completed":50}\n');
      res.write('{"status":"downloading","total":100,"completed":100}\n');
      res.end('{"status":"success"}\n');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => ollama.listen(0, '127.0.0.1', () => r()));
  const a = ollama.address();
  ollamaUrl = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;

  // Bind the panel to an OS-chosen port so the suite survives a real Modulus
  // daemon already holding the default 7777 on this dev box.
  // A half-set Telegram (valid token, nobody allowlisted) — a misconfiguration,
  // so the panel stays not-configured and promotion is rejected until it's
  // either completed or cleared. (A panel-only config is covered separately.)
  saveConfig(
    {
      telegram: { token: `123456:${TOKEN_SECRET}`, allowedIds: [] },
      ollama: { url: ollamaUrl },
      models: { chat: 'qwen2.5:0.5b' },
      panel: { enabled: true, port: 0, bind: '127.0.0.1' },
    },
    home,
  );

  server = await startSetupServer(home, { onStop: () => {} });
  const u = new URL(server.handle.url);
  base = `${u.protocol}//${u.host}`;
  token = u.searchParams.get('token') ?? '';
});

after(async () => {
  await server.close();
  ollama.close();
  rmSync(home, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (SAVED[k] !== undefined) process.env[k] = SAVED[k];
  }
});

test('GET /api/state reports setupMode and not configured', async () => {
  const res = await authed('/api/state');
  assert.equal(res.status, 200);
  const body = (await res.json()) as { setupMode: boolean; configured: boolean };
  assert.equal(body.setupMode, true);
  assert.equal(body.configured, false);
});

test('GET /api/modules responds in setup mode', async () => {
  const res = await authed('/api/modules');
  assert.equal(res.status, 200);
  const body = (await res.json()) as { modules: unknown[] };
  assert.ok(Array.isArray(body.modules));
});

test('POST /api/setup/complete with an incomplete Telegram config is 400', async () => {
  const res = await authed('/api/setup/complete', { method: 'POST' });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error?: string };
  assert.match(body.error ?? '', /allowed person|web panel only/i);
});

test('ollama pull-stream relays NDJSON progress then a done frame', async () => {
  // Point the config at the stub Ollama; pull-stream re-reads effectiveConfig.
  saveConfig({ ...effectiveConfig(home), ollama: { url: ollamaUrl } }, home);
  const res = await fetch(
    `${base}/api/ollama/pull-stream?model=qwen2.5%3A7b&token=${encodeURIComponent(token)}`,
  );
  assert.equal(res.status, 200);
  const text = await res.text();
  const frames = text
    .split('\n\n')
    .map((b) => b.split('\n').find((l) => l.startsWith('data: ')))
    .filter(Boolean)
    .map((l) => JSON.parse((l as string).slice(6)) as { type: string; ok?: boolean });
  assert.ok(
    frames.some((f) => f.type === 'progress'),
    'expected at least one progress frame',
  );
  const done = frames.find((f) => f.type === 'done');
  assert.ok(done, 'expected a done frame');
  assert.equal(done?.ok, true);
});

test('POST /api/setup/complete with a valid config returns 200 and resolves promotion', async () => {
  saveConfig(
    {
      ...effectiveConfig(home),
      telegram: { token: `123456:${TOKEN_SECRET}`, allowedIds: [123] },
      ollama: { url: ollamaUrl },
    },
    home,
  );
  const res = await authed('/api/setup/complete', { method: 'POST' });
  assert.equal(res.status, 200);
  // complete() fires ~100ms after the response; the promotion promise resolves.
  await Promise.race([
    server.completed,
    new Promise((_r, reject) =>
      setTimeout(() => reject(new Error('completed never resolved')), 2000),
    ),
  ]);
});

// Telegram is optional: a config with a chat model but no bot token is a valid
// panel-only install and must promote. Uses its own server so it doesn't race
// the shared one's promotion lifecycle.
test('POST /api/setup/complete promotes a panel-only config (no Telegram)', async () => {
  const home2 = mkdtempSync(join(tmpdir(), 'modulus-setup-panel-'));
  let srv: SetupServer | undefined;
  try {
    saveConfig(
      {
        telegram: { token: '', allowedIds: [] },
        ollama: { url: ollamaUrl },
        models: { chat: 'qwen2.5:0.5b' },
        panel: { enabled: true, port: 0, bind: '127.0.0.1' },
      },
      home2,
    );
    srv = await startSetupServer(home2, { onStop: () => {} });
    const u = new URL(srv.handle.url);
    const res = await fetch(`${u.protocol}//${u.host}/api/setup/complete`, {
      method: 'POST',
      headers: { 'x-modulus-token': u.searchParams.get('token') ?? '' },
    });
    assert.equal(res.status, 200);
    await Promise.race([
      srv.completed,
      new Promise((_r, reject) =>
        setTimeout(() => reject(new Error('panel-only promotion never resolved')), 2000),
      ),
    ]);
  } finally {
    await srv?.close();
    rmSync(home2, { recursive: true, force: true });
  }
});
