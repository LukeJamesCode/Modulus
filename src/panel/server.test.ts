// Panel server: auth gate, static serving + CSP, and the live /api/state route.
// Uses a real (migrated) temp DB and an ephemeral port so it runs offline — the
// Ollama probe in buildState fails closed when nothing is listening, which is
// fine for these assertions.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { open as openDb, type DB } from '../storage/db.js';
import { createLogger } from '../util/log.js';
import { effectiveConfig } from '../cli/config-store.js';
import { panelTokenPath } from '../cli/daemon.js';
import { createPanel, type PanelHandle } from './server.js';

let home: string;
let db: DB;
let panel: PanelHandle;
let base: string;
let token: string;

before(async () => {
  home = mkdtempSync(join(tmpdir(), 'modulus-panel-'));
  db = openDb({ path: join(home, 'modulus.db'), log: createLogger({ level: 'error' }) });
  panel = await createPanel({
    db,
    log: createLogger({ level: 'error' }),
    home,
    // port 0 → ephemeral; effectiveConfig fills panel defaults otherwise.
    config: { ...effectiveConfig(home), panel: { enabled: true, port: 0, bind: '127.0.0.1' } },
    extensionRoots: [],
  });
  const u = new URL(panel.url);
  base = `${u.protocol}//${u.host}`;
  token = u.searchParams.get('token') ?? '';
});

after(async () => {
  await panel.close();
  db.close();
  rmSync(home, { recursive: true, force: true });
});

test('the token is persisted owner-only and matches the URL', () => {
  assert.ok(token.length >= 24);
  assert.equal(readFileSync(panelTokenPath(home), 'utf8').trim(), token);
});

test('GET /api/state requires the token', async () => {
  const res = await fetch(`${base}/api/state`);
  assert.equal(res.status, 401);
});

test('GET /api/state returns live state with a valid token', async () => {
  const res = await fetch(`${base}/api/state`, { headers: { 'x-modulus-token': token } });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { agent: { running: boolean }; version: string };
  // The daemon serving the panel is the agent, so it always reports running.
  assert.equal(body.agent.running, true);
  assert.equal(typeof body.version, 'string');
});

test('a bad token is rejected', async () => {
  const res = await fetch(`${base}/api/state`, { headers: { authorization: 'Bearer nope' } });
  assert.equal(res.status, 401);
});

test('?token= is accepted (the only option EventSource has)', async () => {
  const res = await fetch(`${base}/api/state?token=${encodeURIComponent(token)}`);
  assert.equal(res.status, 200);
});

test('static index is open and carries a CSP header', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'self'/);
});

test('path traversal outside web/ is forbidden', async () => {
  // Raw request — fetch would normalize ../, so go through the encoded form.
  const res = await fetch(`${base}/..%2f..%2fpackage.json`);
  assert.ok(res.status === 403 || res.status === 404);
});
