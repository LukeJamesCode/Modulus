import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../storage/db.js';
import { createLogger } from '../util/log.js';
import { createAgentRegistry } from '../core/agents.js';
import { createConversationRouter } from '../core/conversation-routing.js';
import { handleBind, handleUnbind, type BindingDeps } from './binding-commands.js';
import type { Orchestrator } from '../core/orchestrator.js';

const silentLog = () => createLogger({ out: () => {}, err: () => {} });
const fakeOrch = (): Orchestrator => ({
  handleUserMessage: async () => {},
  stop: () => false,
  newChat: () => {},
  lastError: () => undefined,
  shutdown: async () => {},
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'modulus-bindcmd-'));
  const db = open({ path: join(dir, 'g.db') });
  const log = silentLog();
  const registry = createAgentRegistry(db);
  const router = createConversationRouter({
    db,
    registry,
    log,
    defaultOrchestrator: fakeOrch(),
    orchestratorFactory: () => fakeOrch(),
  });
  const deps: BindingDeps = { router, registry };
  return {
    registry,
    router,
    deps,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('/bind with no arg on an unbound chat explains the default', () => {
  const { deps, cleanup } = setup();
  try {
    assert.match(handleBind(deps, '', 42), /default Modulus assistant/);
  } finally {
    cleanup();
  }
});

test('/bind <agent> binds the chat', () => {
  const { registry, router, deps, cleanup } = setup();
  try {
    const a = registry.create({ name: 'coder', systemPrompt: 'x' });
    const out = handleBind(deps, 'coder', 42);
    assert.match(out, /now talks to 'coder'/);
    assert.equal(router.boundAgentId(42), a.id);
  } finally {
    cleanup();
  }
});

test('/bind an unknown agent does nothing', () => {
  const { router, deps, cleanup } = setup();
  try {
    assert.match(handleBind(deps, 'ghost', 42), /No agent named 'ghost'/);
    assert.equal(router.boundAgentId(42), null);
  } finally {
    cleanup();
  }
});

test('/bind with no arg on a bound chat shows the current agent', () => {
  const { registry, deps, cleanup } = setup();
  try {
    registry.create({ name: 'coder', systemPrompt: 'x' });
    handleBind(deps, 'coder', 42);
    assert.match(handleBind(deps, '', 42), /talks to 'coder'/);
  } finally {
    cleanup();
  }
});

test('/unbind restores the default', () => {
  const { registry, router, deps, cleanup } = setup();
  try {
    registry.create({ name: 'coder', systemPrompt: 'x' });
    handleBind(deps, 'coder', 42);
    const out = handleUnbind(deps, 42);
    assert.match(out, /back to the default/);
    assert.equal(router.boundAgentId(42), null);
  } finally {
    cleanup();
  }
});

test('/unbind on an already-default chat says so', () => {
  const { deps, cleanup } = setup();
  try {
    assert.match(handleUnbind(deps, 42), /already uses the default/);
  } finally {
    cleanup();
  }
});
