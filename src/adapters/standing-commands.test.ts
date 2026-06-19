import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../storage/db.js';
import { createAgentRegistry } from '../core/agents.js';
import { createStandingOrderStore } from '../core/standing-orders.js';
import { handleStanding, type StandingDeps } from './standing-commands.js';

const CHAT = 321;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'modulus-standing-cmd-'));
  const db = open({ path: join(dir, 'g.db') });
  const registry = createAgentRegistry(db);
  const store = createStandingOrderStore(db);
  const deps: StandingDeps = { store, registry };
  return {
    db,
    registry,
    store,
    deps,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('/standing add creates an agentic order for a known agent', () => {
  const { registry, store, deps, cleanup } = setup();
  try {
    const agent = registry.create({ name: 'scout', systemPrompt: 'x', toolAllowlist: [] });
    const reply = handleStanding(deps, CHAT, 'add scout, check the server status');
    assert.match(reply, /Standing order #\d+/);
    const rows = store.list({ chatId: CHAT, active: true });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.agentId, agent.id);
    assert.equal(rows[0]!.instruction, 'check the server status');
  } finally {
    cleanup();
  }
});

test('/standing add rejects an unknown agent', () => {
  const { deps, cleanup } = setup();
  try {
    assert.match(handleStanding(deps, CHAT, 'add ghost, do things'), /No agent named/);
  } finally {
    cleanup();
  }
});

test('/standing lists this chat orders and cancels by id', () => {
  const { registry, store, deps, cleanup } = setup();
  try {
    registry.create({ name: 'scout', systemPrompt: 'x', toolAllowlist: [] });
    handleStanding(deps, CHAT, 'add scout, watch the logs');
    const id = store.list({ chatId: CHAT, active: true })[0]!.id;
    assert.match(handleStanding(deps, CHAT, ''), /Standing orders/);
    assert.match(handleStanding(deps, 999, `cancel ${id}`), /No standing order/);
    assert.match(handleStanding(deps, CHAT, `cancel ${id}`), /Cancelled standing order/);
    assert.equal(store.list({ chatId: CHAT, active: true }).length, 0);
  } finally {
    cleanup();
  }
});

test('bare /standing with no orders shows usage', () => {
  const { deps, cleanup } = setup();
  try {
    assert.match(handleStanding(deps, CHAT, ''), /No standing orders yet/);
  } finally {
    cleanup();
  }
});
