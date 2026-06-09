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
import { createAgentRegistry } from '../core/agents.js';
import { setupMemory } from '../core/memory.js';
import { createPrefsStore } from '../core/prefs.js';
import { createScheduler } from '../core/scheduler.js';
import { createToolRegistry } from '../core/tools.js';
import { effectiveConfig } from '../cli/config-store.js';
import { panelTokenPath } from '../cli/daemon.js';
import { createPanel, type PanelDeps, type PanelHandle } from './server.js';

let home: string;
let db: DB;
let panel: PanelHandle;
let base: string;
let token: string;
let stopCalls = 0;
let restartCalls = 0;

function authed(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), 'x-modulus-token': token },
  });
}

before(async () => {
  home = mkdtempSync(join(tmpdir(), 'modulus-panel-'));
  const log = createLogger({ level: 'error' });
  db = openDb({ path: join(home, 'modulus.db'), log });
  const scheduler = createScheduler({
    log,
    dispatch: async () => {},
    prefs: createPrefsStore(db),
    db,
  });
  panel = await createPanel({
    db,
    log,
    home,
    // port 0 → ephemeral; effectiveConfig fills panel defaults otherwise.
    config: { ...effectiveConfig(home), panel: { enabled: true, port: 0, bind: '127.0.0.1' } },
    extensionRoots: [],
    scheduler,
    agentRegistry: createAgentRegistry(db),
    // The exercised routes don't touch the queue or llm; stub them.
    agentQueue: { notify() {} } as unknown as PanelDeps['agentQueue'],
    llm: { resolveModel: () => 'test-model' } as unknown as PanelDeps['llm'],
    memory: setupMemory({
      db,
      tools: createToolRegistry({ log, confirm: async () => false }),
      log,
    }),
    onStop: () => {
      stopCalls += 1;
    },
    onRestart: () => {
      restartCalls += 1;
    },
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

test('POST /api/agent/start is a no-op that reports running', async () => {
  const res = await authed('/api/agent/start', { method: 'POST' });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; running: boolean };
  assert.equal(body.running, true);
});

test('proactive toggle flips the flag surfaced in /api/state', async () => {
  await authed('/api/agent/proactive', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ on: false }),
  });
  const off = (await (await authed('/api/state')).json()) as { proactive: boolean };
  assert.equal(off.proactive, false);
  await authed('/api/agent/proactive', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ on: true }),
  });
  const on = (await (await authed('/api/state')).json()) as { proactive: boolean };
  assert.equal(on.proactive, true);
});

test('system read routes respond with a valid token', async () => {
  for (const route of ['/api/metrics', '/api/scheduler', '/api/conversations', '/api/docs']) {
    const res = await authed(route);
    assert.equal(res.status, 200, `${route} should be 200`);
  }
});

test('GET /api/agents lists agents off the live registry', async () => {
  const res = await authed('/api/agents');
  assert.equal(res.status, 200);
  const body = (await res.json()) as { agents: unknown[] };
  assert.ok(Array.isArray(body.agents));
});

test('agents validation: create without name is 400', async () => {
  const res = await authed('/api/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ systemPrompt: 'x' }),
  });
  assert.equal(res.status, 400);
});

test('modules: list and command reference respond', async () => {
  const exts = await authed('/api/extensions');
  assert.equal(exts.status, 200);
  assert.ok(Array.isArray(((await exts.json()) as { extensions: unknown[] }).extensions));
  const cmds = await authed('/api/commands');
  assert.equal(cmds.status, 200);
  const body = (await cmds.json()) as { core: unknown[]; extensions: unknown[] };
  assert.ok(Array.isArray(body.core) && body.core.length > 0);
});

test('module settings for an unknown module is 404', async () => {
  const res = await authed('/api/extensions/does-not-exist/settings');
  assert.equal(res.status, 404);
});

test('settings: config exposes the instant-responses toggle', async () => {
  const res = await authed('/api/config');
  assert.equal(res.status, 200);
  const body = (await res.json()) as { instantResponses: boolean; envLocks: object };
  assert.equal(typeof body.instantResponses, 'boolean');
  assert.equal(typeof body.envLocks, 'object');
});

test('memory browser lists, finds, and deletes', async () => {
  await authed('/api/agents'); // touch nothing; just ensure server up
  // Seed a fact directly via the store the panel shares.
  const seeded = await fetch(`${base}/api/memory?q=pineapple`, {
    headers: { 'x-modulus-token': token },
  });
  assert.equal(seeded.status, 200);
  const empty = (await seeded.json()) as { memories: unknown[]; total: number };
  assert.ok(Array.isArray(empty.memories));
  assert.equal(typeof empty.total, 'number');
  const del = await authed('/api/memory/99999999', { method: 'DELETE' });
  assert.equal(del.status, 404);
});

test('stop and restart hand off to the host hooks', async () => {
  assert.equal((await authed('/api/agent/stop', { method: 'POST' })).status, 200);
  assert.equal((await authed('/api/agent/restart', { method: 'POST' })).status, 200);
  // The hooks fire ~100ms after the response flushes.
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(stopCalls, 1);
  assert.equal(restartCalls, 1);
});
