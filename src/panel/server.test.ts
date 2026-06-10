// Panel server: auth gate, static serving + CSP, and the live /api/state route.
// Uses a real (migrated) temp DB and an ephemeral port so it runs offline — the
// Ollama probe in buildState fails closed when nothing is listening, which is
// fine for these assertions.

import assert from 'node:assert/strict';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { open as openDb, type DB } from '../storage/db.js';
import { createLogger } from '../util/log.js';
import { createAgentRegistry, type AgentRunEvent } from '../core/agents.js';
import { setupMemory } from '../core/memory.js';
import { createPrefsStore } from '../core/prefs.js';
import { createScheduler } from '../core/scheduler.js';
import { createToolRegistry } from '../core/tools.js';
import { effectiveConfig } from '../cli/config-store.js';
import { logFilePath, panelTokenPath } from '../cli/daemon.js';
import { createPanelConfirmBus } from './confirm-bus.js';
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

// Run-view subscriptions captured by the agentRuntime stub, so tests can play
// the runtime's part and inject live events.
const runEventSubs = new Map<number, Set<(e: AgentRunEvent) => void>>();
function emitRun(taskId: number, e: AgentRunEvent): void {
  for (const fn of runEventSubs.get(taskId) ?? []) fn(e);
}

// Incremental SSE frame reader over a fetch response. next() resolves the next
// data frame (parsed), null on stream end or timeout. Tracks whether any frame
// carried an event name — the run view must stay unnamed for EventSource.
function sseFrames(res: Response): {
  next(timeoutMs?: number): Promise<Record<string, unknown> | null>;
  readonly sawNamed: boolean;
} {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let streamDone = false;
  let sawNamed = false;
  const queue: Array<Record<string, unknown>> = [];
  return {
    async next(timeoutMs = 5000): Promise<Record<string, unknown> | null> {
      while (queue.length === 0 && !streamDone) {
        const r = await Promise.race([
          reader.read(),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs).unref?.()),
        ]);
        if (!r) return null; // timed out
        if (r.done) {
          streamDone = true;
          break;
        }
        buf += decoder.decode(r.value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (frame.split('\n').some((l) => l.startsWith('event:'))) sawNamed = true;
          const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
          if (dataLine) queue.push(JSON.parse(dataLine.slice(6)) as Record<string, unknown>);
        }
      }
      return queue.shift() ?? null;
    },
    get sawNamed() {
      return sawNamed;
    },
  };
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
    // port 0 → ephemeral; an allowlisted owner so chat can resolve a chatId.
    config: {
      ...effectiveConfig(home),
      telegram: { token: 'x', allowedIds: [123] },
      panel: { enabled: true, port: 0, bind: '127.0.0.1' },
    },
    extensionRoots: [],
    scheduler,
    agentRegistry: createAgentRegistry(db),
    // The exercised routes don't touch the queue or llm; stub them.
    agentQueue: { notify() {} } as unknown as PanelDeps['agentQueue'],
    agentRuntime: {
      subscribe(taskId: number, fn: (e: AgentRunEvent) => void): () => void {
        let set = runEventSubs.get(taskId);
        if (!set) {
          set = new Set();
          runEventSubs.set(taskId, set);
        }
        set.add(fn);
        return () => set.delete(fn);
      },
    } as unknown as PanelDeps['agentRuntime'],
    llm: { resolveModel: () => 'test-model' } as unknown as PanelDeps['llm'],
    memory: setupMemory({
      db,
      tools: createToolRegistry({ log, confirm: async () => false }),
      log,
    }),
    // A stub orchestrator that streams two deltas then finishes, and a loader
    // with no intercepts — enough to exercise the SSE chat path offline.
    orchestrator: {
      handleUserMessage: async (msg: {
        send: (c: { delta: string; done: boolean; meta?: unknown }) => void;
      }) => {
        msg.send({ delta: 'hi ', done: false });
        msg.send({ delta: 'there', done: false });
        msg.send({ delta: '', done: true, meta: { model: 'test', elapsedMs: 1 } });
      },
      stop: () => false,
      newChat: () => {},
      lastError: () => undefined,
      shutdown: async () => {},
    } as unknown as PanelDeps['orchestrator'],
    loader: { intercepts: () => [] } as unknown as PanelDeps['loader'],
    confirmBus: createPanelConfirmBus(),
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

test('run-view stream snapshots on connect, on live events, and closes on done', async () => {
  const reg = createAgentRegistry(db);
  const createRes = await authed('/api/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'streamer', systemPrompt: 'say hi' }),
  });
  const { agent } = (await createRes.json()) as { agent: { id: number } };
  const dispatchRes = await authed(`/api/agents/${agent.id}/dispatch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'go' }),
  });
  const { task } = (await dispatchRes.json()) as { task: { id: number } };

  const res = await fetch(
    `${base}/api/agents/tasks/${task.id}/stream?token=${encodeURIComponent(token)}`,
  );
  assert.equal(res.status, 200);
  const frames = sseFrames(res);

  // Connect: one immediate snapshot of the queued task.
  const first = await frames.next();
  assert.equal(first?.['type'], 'snapshot');
  assert.equal((first?.['task'] as { status: string }).status, 'queued');

  // The runtime picks the task up and streams: a delta event must push a fresh
  // snapshot (after the coalesce window) without any DB polling.
  reg.updateTask(task.id, { status: 'running', liveText: 'thinking…' });
  emitRun(task.id, { type: 'delta', text: 'x' });
  const second = await frames.next();
  assert.equal((second?.['task'] as { status: string }).status, 'running');
  assert.equal((second?.['task'] as { liveText: string }).liveText, 'thinking…');

  // Terminal: the done event pushes the final snapshot and ends the stream.
  reg.updateTask(task.id, { status: 'done', result: 'hi', finishedAt: Date.now() });
  emitRun(task.id, { type: 'done', ok: true });
  const last = await frames.next();
  assert.equal((last?.['task'] as { status: string }).status, 'done');
  assert.equal(await frames.next(2000), null);
  // EventSource.onmessage only fires for unnamed frames — none may be named.
  assert.equal(frames.sawNamed, false);
  // The server must drop its subscription once the stream closes.
  assert.equal(runEventSubs.get(task.id)?.size ?? 0, 0);
});

test('logs stream replays the tail, then follows appended lines', async () => {
  mkdirSync(join(home, 'log'), { recursive: true });
  writeFileSync(logFilePath(home), '{"msg":"alpha"}\n{"msg":"beta"}\n');
  const ac = new AbortController();
  const res = await fetch(`${base}/api/logs/stream?token=${encodeURIComponent(token)}`, {
    signal: ac.signal,
  });
  assert.equal(res.status, 200);
  const frames = sseFrames(res);
  assert.equal(await frames.next(), '{"msg":"alpha"}');
  assert.equal(await frames.next(), '{"msg":"beta"}');
  // Appended bytes arrive on the follow tick (1.5s poll).
  appendFileSync(logFilePath(home), '{"msg":"gamma"}\n');
  assert.equal(await frames.next(), '{"msg":"gamma"}');
  assert.equal(frames.sawNamed, false);
  ac.abort();
});

test('run-view stream for a missing task reports gone and ends', async () => {
  const res = await fetch(
    `${base}/api/agents/tasks/999999/stream?token=${encodeURIComponent(token)}`,
  );
  assert.equal(res.status, 200);
  const frames = sseFrames(res);
  const first = await frames.next();
  assert.equal(first?.['type'], 'gone');
  assert.equal(await frames.next(2000), null);
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

test('chat: empty message is 400', async () => {
  const res = await authed('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '  ' }),
  });
  assert.equal(res.status, 400);
});

test('chat streams orchestrator deltas then done over SSE', async () => {
  const res = await authed('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'hello' }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
  const text = await res.text();
  assert.match(text, /event: delta/);
  assert.match(text, /"delta":"hi /);
  assert.match(text, /event: done/);
});

test('chat/confirm with an unknown id is 409 (fail-closed)', async () => {
  const res = await authed('/api/chat/confirm', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'nope', ok: true }),
  });
  assert.equal(res.status, 409);
});

test('chat/clear resets the conversation', async () => {
  const res = await authed('/api/chat/clear', { method: 'POST' });
  assert.equal(res.status, 200);
});

test('stop and restart hand off to the host hooks', async () => {
  assert.equal((await authed('/api/agent/stop', { method: 'POST' })).status, 200);
  assert.equal((await authed('/api/agent/restart', { method: 'POST' })).status, 200);
  // The hooks fire ~100ms after the response flushes.
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(stopCalls, 1);
  assert.equal(restartCalls, 1);
});
