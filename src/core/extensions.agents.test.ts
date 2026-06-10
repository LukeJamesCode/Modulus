// Module-provided agents (manifest v2 `agents`). The behaviour that matters:
// - Installing a module adds a delegatable specialist with zero glue code —
//   the "modules are mods" promise extended to agents.
// - Sync is an upsert: a reload/upgrade must keep the agent's id (task history
//   hangs off it), never delete-and-recreate.
// - A module can never hijack a user-created agent by naming one after it.
// - Uninstall/disable/orphaned modules must not leave dead personas in the
//   fleet pointing at tools that no longer exist.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../storage/db.js';
import { createLogger } from '../util/log.js';
import { createScheduler } from './scheduler.js';
import { createToolRegistry } from './tools.js';
import { createExtensionLoader, type ExtensionLoaderOptions } from './extensions.js';
import { createAgentRegistry } from './agents.js';
import type { LLM, ProfileConfig, ProfileName } from './llm.js';

const log = createLogger({ level: 'error', out: () => {}, err: () => {} });

const fakeLlm: LLM = {
  chat: () => {
    throw new Error('not used');
  },
  async health() {
    return { ok: true, models: [] };
  },
  listProfiles(): Record<ProfileName, ProfileConfig | null> {
    return { chat: null, reason: null, tools: null };
  },
  resolveModel() {
    return 'fake';
  },
  breakerSnapshot: () => ({
    state: 'closed',
    failures: 0,
    consecutiveSuccesses: 0,
    openedAt: null,
    retryAt: null,
  }),
  stopIdleEviction: () => {},
};

function writeExt(root: string, name: string, manifest: Record<string, unknown>): string {
  const folder = join(root, name);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return folder;
}

function harness(): {
  dir: string;
  root: string;
  db: ReturnType<typeof open>;
  agents: ReturnType<typeof createAgentRegistry>;
  makeLoader: () => ReturnType<typeof createExtensionLoader>;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'modulus-extagents-'));
  const root = join(dir, 'exts');
  mkdirSync(root, { recursive: true });
  const db = open({ path: join(dir, 'g.db'), log });
  const agents = createAgentRegistry(db);
  const makeLoader = () => {
    const opts: ExtensionLoaderOptions = {
      roots: [root],
      stateRoot: join(dir, 'state'),
      db,
      llm: fakeLlm,
      log,
      scheduler: createScheduler({ log, dispatch: () => {} }),
      tools: createToolRegistry({ log }),
      agents,
      hostVersion: '0.0.0',
      chatId: 0,
      watch: false,
    };
    return createExtensionLoader(opts);
  };
  return {
    dir,
    root,
    db,
    agents,
    makeLoader,
    cleanup: () => {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const CODER_MANIFEST = {
  name: 'demo-codex',
  version: '1.0.0',
  modulus: '*',
  agents: [
    {
      name: 'coder',
      role: 'Writes and reviews code',
      systemPrompt: 'You are a coding specialist.',
      profile: 'reason',
    },
  ],
};

test('loading a module with manifest agents registers them into the fleet', async () => {
  const h = harness();
  try {
    writeExt(h.root, 'demo-codex', CODER_MANIFEST);
    const loader = h.makeLoader();
    await loader.loadAll();

    const coder = h.agents.getByName('coder');
    assert.ok(coder, 'manifest agent should land in the fleet');
    assert.equal(coder.origin, 'ext:demo-codex');
    assert.equal(coder.profile, 'reason');
    assert.equal(coder.systemPrompt, 'You are a coding specialist.');
    assert.equal(loader.list().find((e) => e.name === 'demo-codex')!.registeredAgents.length, 1);
    await loader.shutdown();
  } finally {
    h.cleanup();
  }
});

test('default tool allowlist scopes a module agent to its own module', async () => {
  const h = harness();
  try {
    writeExt(h.root, 'demo-codex', {
      ...CODER_MANIFEST,
      agents: [{ name: 'coder', systemPrompt: 'Code.' }],
    });
    const loader = h.makeLoader();
    await loader.loadAll();
    const coder = h.agents.getByName('coder')!;
    // Scoped manifest = better tool selection on tiny models, and a module
    // agent must not silently inherit every tool on the box.
    assert.deepEqual(coder.toolAllowlist, ['demo-codex']);
    assert.equal(coder.profile, 'tools');
    await loader.shutdown();
  } finally {
    h.cleanup();
  }
});

test('re-loading upserts in place: same id, updated fields, no duplicates', async () => {
  const h = harness();
  try {
    const folder = writeExt(h.root, 'demo-codex', CODER_MANIFEST);
    const loader = h.makeLoader();
    await loader.loadAll();
    const before = h.agents.getByName('coder')!;
    await loader.shutdown();

    // Simulate a module upgrade that rewrites the persona.
    writeFileSync(
      join(folder, 'manifest.json'),
      JSON.stringify(
        {
          ...CODER_MANIFEST,
          version: '1.1.0',
          agents: [{ ...CODER_MANIFEST.agents[0], systemPrompt: 'You are a careful coder.' }],
        },
        null,
        2,
      ),
    );
    const loader2 = h.makeLoader();
    await loader2.loadAll();
    const after = h.agents.getByName('coder')!;
    assert.equal(after.id, before.id, 'upsert must keep the id — task history hangs off it');
    assert.equal(after.systemPrompt, 'You are a careful coder.');
    assert.equal(h.agents.list().filter((a) => a.name === 'coder').length, 1);
    await loader2.shutdown();
  } finally {
    h.cleanup();
  }
});

test('a module cannot hijack a user-created agent by name', async () => {
  const h = harness();
  try {
    const mine = h.agents.create({ name: 'coder', systemPrompt: 'My hand-tuned coder.' });
    writeExt(h.root, 'demo-codex', CODER_MANIFEST);
    const loader = h.makeLoader();
    await loader.loadAll();

    const coder = h.agents.getByName('coder')!;
    assert.equal(coder.id, mine.id, 'user agent must survive untouched');
    assert.equal(coder.systemPrompt, 'My hand-tuned coder.');
    assert.equal(coder.origin, null);
    assert.equal(loader.list().find((e) => e.name === 'demo-codex')!.registeredAgents.length, 0);
    await loader.shutdown();
  } finally {
    h.cleanup();
  }
});

test('disabling a module removes its agents; orphaned module agents are swept', async () => {
  const h = harness();
  try {
    writeExt(h.root, 'demo-codex', CODER_MANIFEST);
    const loader = h.makeLoader();
    await loader.loadAll();
    assert.ok(h.agents.getByName('coder'));
    await loader.shutdown();

    // A leftover from a module uninstalled while the daemon was down.
    h.agents.create({ name: 'ghostling', systemPrompt: 'Orphan.', origin: 'ext:ghost-module' });
    // Disable demo-codex the way the CLI/panel does: flip module_state.
    h.db.prepare(`UPDATE module_state SET enabled = 0 WHERE name = 'demo-codex'`).run();

    const loader2 = h.makeLoader();
    await loader2.loadAll();
    assert.equal(h.agents.getByName('coder'), undefined, 'disabled module leaves no dead persona');
    assert.equal(h.agents.getByName('ghostling'), undefined, 'orphan sweep cleans uninstalled');
    await loader2.shutdown();
  } finally {
    h.cleanup();
  }
});

test('an agent dropped from the manifest is removed on the next load', async () => {
  const h = harness();
  try {
    const folder = writeExt(h.root, 'demo-codex', {
      ...CODER_MANIFEST,
      agents: [
        { name: 'coder', systemPrompt: 'Code.' },
        { name: 'reviewer', systemPrompt: 'Review.' },
      ],
    });
    const loader = h.makeLoader();
    await loader.loadAll();
    assert.ok(h.agents.getByName('reviewer'));
    await loader.shutdown();

    writeFileSync(
      join(folder, 'manifest.json'),
      JSON.stringify({ ...CODER_MANIFEST, agents: [{ name: 'coder', systemPrompt: 'Code.' }] }),
    );
    const loader2 = h.makeLoader();
    await loader2.loadAll();
    assert.equal(h.agents.getByName('reviewer'), undefined);
    assert.ok(h.agents.getByName('coder'));
    await loader2.shutdown();
  } finally {
    h.cleanup();
  }
});
