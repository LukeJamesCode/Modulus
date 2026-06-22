import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../storage/db.js';
import { createLogger } from '../util/log.js';
import { createAgentRegistry } from './agents.js';
import { createAgentApprovalStore, createApprovalManager, isToolPreapproved } from './agent-approvals.js';
import type { ToolHandler, ToolPermissionTier } from './tools.js';

// Minimal handler for the isToolPreapproved truth table.
function handler(name: string, tier: ToolPermissionTier, module?: string): ToolHandler {
  return {
    name,
    description: '',
    tier,
    ...(module ? { module } : {}),
    parameters: { type: 'object', properties: {} },
    invoke: async () => '',
  };
}

function silentLogger() {
  return createLogger({ level: 'error', out: () => {}, err: () => {} });
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'modulus-appr-'));
  const db = open({ path: join(dir, 'g.db') });
  const registry = createAgentRegistry(db);
  const agent = registry.create({ name: 'risky', systemPrompt: 'do things' });
  const task = registry.enqueue({ agentId: agent.id, prompt: 'task' });
  return {
    registry,
    agent,
    task,
    store: createAgentApprovalStore(db),
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

test('isToolPreapproved: confirm-tier only, by tool name or module', () => {
  // Matches by exact tool name.
  assert.equal(isToolPreapproved(['browser_read'], handler('browser_read', 'confirm')), true);
  // Matches by the registering module name.
  assert.equal(
    isToolPreapproved(['modulus-browser'], handler('browser_read', 'confirm', 'modulus-browser')),
    true,
  );
  // Owner-tier NEVER bypasses, even when explicitly listed.
  assert.equal(isToolPreapproved(['danger_tool'], handler('danger_tool', 'owner')), false);
  // Auto-tier doesn't go through the confirm gate, so it's never "pre-approved".
  assert.equal(isToolPreapproved(['web_search'], handler('web_search', 'auto')), false);
  // Empty / null / non-matching lists => fail closed.
  assert.equal(isToolPreapproved([], handler('browser_read', 'confirm')), false);
  assert.equal(isToolPreapproved(null, handler('browser_read', 'confirm')), false);
  assert.equal(isToolPreapproved(['other'], handler('browser_read', 'confirm')), false);
});

test('store: a new approval is pending and decide() is one-shot', () => {
  const t = setup();
  try {
    const a = t.store.create({
      taskId: t.task.id,
      agentId: t.agent.id,
      agentName: 'risky',
      toolName: 'codex_handoff',
      preview: 'spend a Codex call?',
      args: { task: 'refactor' },
    });
    assert.equal(a.status, 'pending');
    assert.deepEqual(a.args, { task: 'refactor' });
    assert.equal(t.store.listPending().length, 1);

    const decided = t.store.decide(a.id, true, 'panel');
    assert.equal(decided?.status, 'approved');
    assert.equal(decided?.decidedBy, 'panel');
    // A second decision loses the race — the row is no longer pending.
    assert.equal(t.store.decide(a.id, false, 'telegram'), undefined);
    assert.equal(t.store.listPending().length, 0);
  } finally {
    t.cleanup();
  }
});

test('manager: a Telegram Yes resolves the parked call as approved', async () => {
  const t = setup();
  try {
    const mgr = createApprovalManager({
      store: t.store,
      registry: t.registry,
      log: silentLogger(),
      pollMs: 50,
    });
    const notified: number[] = [];
    mgr.setNotifier((appr) => {
      notified.push(appr.id);
    });

    const parked = mgr.request({
      taskId: t.task.id,
      toolName: 'codex_handoff',
      preview: 'spend a call?',
      args: null,
    });
    await tick();
    const pending = t.store.listPending();
    assert.equal(pending.length, 1);
    // The agent's name is resolved from the task and the owner is notified.
    assert.equal(pending[0]!.agentName, 'risky');
    assert.deepEqual(notified, [pending[0]!.id]);

    mgr.resolveFromTelegram(pending[0]!.id, true, 999);
    assert.equal(await parked, true);
    assert.equal(t.store.get(pending[0]!.id)?.status, 'approved');
    mgr.shutdown();
  } finally {
    t.cleanup();
  }
});

test('manager: a panel decision (DB write from another process) resolves via poll', async () => {
  const t = setup();
  try {
    const mgr = createApprovalManager({
      store: t.store,
      registry: t.registry,
      log: silentLogger(),
      pollMs: 20,
    });
    const parked = mgr.request({
      taskId: t.task.id,
      toolName: 'codex_handoff',
      preview: 'do it?',
      args: null,
    });
    await tick();
    const id = t.store.listPending()[0]!.id;
    // Simulate the separate panel process writing the rejection straight to the
    // DB; the daemon's manager must notice and unblock without an in-process call.
    t.store.decide(id, false, 'panel');
    assert.equal(await parked, false);
    mgr.shutdown();
  } finally {
    t.cleanup();
  }
});

test('manager: cancelling the task rejects the parked approval', async () => {
  const t = setup();
  try {
    const mgr = createApprovalManager({
      store: t.store,
      registry: t.registry,
      log: silentLogger(),
      pollMs: 1000,
    });
    const ac = new AbortController();
    const parked = mgr.request({
      taskId: t.task.id,
      toolName: 'codex_handoff',
      preview: 'risky?',
      args: null,
      signal: ac.signal,
    });
    await tick();
    const id = t.store.listPending()[0]!.id;
    ac.abort();
    assert.equal(await parked, false);
    assert.equal(t.store.get(id)?.status, 'rejected');
    assert.equal(t.store.get(id)?.decidedBy, 'cancelled');
    mgr.shutdown();
  } finally {
    t.cleanup();
  }
});

test('manager: a task cancelled cross-process releases the parked approval via poll', async () => {
  const t = setup();
  try {
    const mgr = createApprovalManager({
      store: t.store,
      registry: t.registry,
      log: silentLogger(),
      pollMs: 20,
    });
    // No abort signal here — simulate the panel cancelling the task by writing
    // the task row, the way the separate panel process does.
    const parked = mgr.request({
      taskId: t.task.id,
      toolName: 'codex_handoff',
      preview: 'risky?',
      args: null,
    });
    await tick();
    const id = t.store.listPending()[0]!.id;
    t.registry.updateTask(t.task.id, { status: 'cancelled' });
    assert.equal(await parked, false);
    assert.equal(t.store.get(id)?.status, 'rejected');
    mgr.shutdown();
  } finally {
    t.cleanup();
  }
});

test('manager: stale pending rows are expired when a new daemon starts', () => {
  const t = setup();
  try {
    t.store.create({
      taskId: t.task.id,
      agentId: t.agent.id,
      agentName: 'risky',
      toolName: 'x',
      preview: 'p',
      args: null,
    });
    assert.equal(t.store.listPending().length, 1);
    // Constructing a manager (daemon startup) clears parked rows from a dead run.
    const mgr = createApprovalManager({
      store: t.store,
      registry: t.registry,
      log: silentLogger(),
      pollMs: 1000,
    });
    assert.equal(t.store.listPending().length, 0);
    mgr.shutdown();
  } finally {
    t.cleanup();
  }
});
