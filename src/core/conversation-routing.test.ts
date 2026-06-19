import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../storage/db.js';
import { createAgentRegistry, type AgentDefinition } from './agents.js';
import { createConversationRouter } from './conversation-routing.js';
import type { Orchestrator } from './orchestrator.js';
import { createLogger } from '../util/log.js';

// Quiet logger — no-op sinks so test runs stay clean.
const silentLog = () => createLogger({ out: () => {}, err: () => {} });

// A fake orchestrator tagged with the persona it represents, so tests can assert
// which one routing returned without running the model.
function fakeOrch(tag: string): Orchestrator & { tag: string } {
  return {
    tag,
    handleUserMessage: async () => {},
    stop: () => false,
    newChat: () => {},
    lastError: () => undefined,
    shutdown: async () => {},
  };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'modulus-routing-'));
  const db = open({ path: join(dir, 'g.db') });
  const registry = createAgentRegistry(db);
  const log = silentLog();
  const def = fakeOrch('default');
  // Record how many times the factory builds each agent's orchestrator, to prove
  // memoization and invalidation.
  const builds: string[] = [];
  const factory = (agent: AgentDefinition): Orchestrator => {
    builds.push(agent.name);
    return fakeOrch(`agent:${agent.name}`);
  };
  const router = createConversationRouter({
    db,
    registry,
    log,
    defaultOrchestrator: def,
    orchestratorFactory: factory,
  });
  return {
    db,
    registry,
    router,
    def,
    builds,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const tag = (o: Orchestrator): string => (o as unknown as { tag: string }).tag;

test('bind routes a chat to the agent orchestrator; unbind restores default', () => {
  const { registry, router, def, cleanup } = setup();
  try {
    const a = registry.create({ name: 'researcher', systemPrompt: 'research things' });

    assert.equal(router.orchestratorFor(42), def, 'unbound chats use the default');
    assert.equal(router.boundAgentId(42), null);

    const b = router.bind(42, a.id, 'user');
    assert.ok(b);
    assert.equal(b!.agentName, 'researcher');
    assert.equal(router.boundAgentId(42), a.id);
    assert.equal(tag(router.orchestratorFor(42)), 'agent:researcher');

    assert.equal(router.unbind(42), true);
    assert.equal(router.orchestratorFor(42), def, 'unbind returns to default');
    assert.equal(router.boundAgentId(42), null);
  } finally {
    cleanup();
  }
});

test('binding a missing agent writes nothing', () => {
  const { router, def, cleanup } = setup();
  try {
    assert.equal(router.bind(1, 999, 'user'), undefined);
    assert.equal(router.orchestratorFor(1), def);
    assert.equal(router.list().length, 0);
  } finally {
    cleanup();
  }
});

test('the per-agent orchestrator is memoized and shared across chats', () => {
  const { registry, router, builds, cleanup } = setup();
  try {
    const a = registry.create({ name: 'coder', systemPrompt: 'write code' });
    router.bind(10, a.id, 'user');
    router.bind(11, a.id, 'user');

    const o1 = router.orchestratorFor(10);
    const o2 = router.orchestratorFor(11);
    assert.equal(o1, o2, 'two chats bound to one agent share its orchestrator');
    router.orchestratorFor(10);
    assert.deepEqual(builds, ['coder'], 'built exactly once');
  } finally {
    cleanup();
  }
});

test('onAgentUpdated invalidates the memoized orchestrator', () => {
  const { registry, router, builds, cleanup } = setup();
  try {
    const a = registry.create({ name: 'planner', systemPrompt: 'v1' });
    router.bind(5, a.id, 'user');
    router.orchestratorFor(5);
    router.onAgentUpdated(a.id);
    router.orchestratorFor(5);
    assert.deepEqual(builds, ['planner', 'planner'], 'rebuilt after update');
  } finally {
    cleanup();
  }
});

test('onAgentRemoved drops all bindings to that agent and its orchestrator', () => {
  const { registry, router, def, builds, cleanup } = setup();
  try {
    const a = registry.create({ name: 'gone', systemPrompt: 'x' });
    router.bind(1, a.id, 'user');
    router.bind(2, a.id, 'handoff:operator');
    router.orchestratorFor(1);

    // start.ts removes the agent row AND calls onAgentRemoved together.
    registry.remove(a.id);
    router.onAgentRemoved(a.id);
    assert.equal(router.boundAgentId(1), null);
    assert.equal(router.boundAgentId(2), null);
    assert.equal(router.orchestratorFor(1), def);
    assert.equal(router.list().length, 0);
    // A fresh agent + bind rebuilds (the removed agent's orchestrator was evicted).
    const b = registry.create({ name: 'replacement', systemPrompt: 'x' });
    router.bind(1, b.id, 'user');
    router.orchestratorFor(1);
    assert.deepEqual(builds, ['gone', 'replacement'], 'orchestrator cache cleared on remove');
  } finally {
    cleanup();
  }
});

test('a stale binding (agent deleted via raw remove) is swept on read', () => {
  const { db, registry, router, def, cleanup } = setup();
  try {
    const a = registry.create({ name: 'temp', systemPrompt: 'x' });
    router.bind(7, a.id, 'user');
    // Delete the agent WITHOUT going through onAgentRemoved (simulates a raw
    // delete path); the binding row is now dangling.
    db.prepare(`DELETE FROM agents WHERE id = ?`).run(a.id);

    assert.equal(router.orchestratorFor(7), def, 'falls back to default');
    assert.equal(router.boundAgentId(7), null, 'and the stale row is swept');
    assert.equal(router.binding(7), undefined);
    assert.equal(router.list().length, 0);
  } finally {
    cleanup();
  }
});

test('bindings survive a reopen (loaded from the table at construction)', () => {
  const { db, registry, router, cleanup } = setup();
  try {
    const a = registry.create({ name: 'persist', systemPrompt: 'x' });
    router.bind(99, a.id, 'user');

    // A second router over the same DB sees the binding warm from the table.
    const log = silentLog();
    const router2 = createConversationRouter({
      db,
      registry,
      log,
      defaultOrchestrator: fakeOrch('default2'),
      orchestratorFactory: (agent) => fakeOrch(`a:${agent.name}`),
    });
    assert.equal(router2.boundAgentId(99), a.id);
    assert.equal(tag(router2.orchestratorFor(99)), 'a:persist');
  } finally {
    cleanup();
  }
});
