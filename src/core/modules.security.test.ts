// Regression tests for the pre-1.0 module-loader security audit:
//   S1 — entrypoint path traversal
//   S2 — intent_pattern ReDoS length cap
//   S6 — module state dir is created 0o700 on POSIX

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../storage/db.js';
import { createLogger } from '../util/log.js';
import { createScheduler } from './scheduler.js';
import { createToolRegistry } from './tools.js';
import { createModuleLoader } from './modules.js';
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
  resolveModel: () => 'fake',
  breakerSnapshot: () => ({
    state: 'closed',
    failures: 0,
    consecutiveSuccesses: 0,
    openedAt: null,
    retryAt: null,
  }),
  stopIdleEviction: () => {},
};

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'modulus-mod-sec-'));
}

function writeModule(
  root: string,
  name: string,
  manifest: Record<string, unknown>,
  files: Record<string, string> = {},
): string {
  const folder = join(root, name);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'manifest.json'), JSON.stringify(manifest));
  for (const [p, c] of Object.entries(files)) {
    const abs = join(folder, p);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, c);
  }
  return folder;
}

test('S1: entrypoint that escapes the module folder is refused', async () => {
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    const root = join(dir, 'exts');
    mkdirSync(root);
    // Plant a "victim" file outside the module folder. importEntrypoint
    // should never reach this even if the manifest tries to escape.
    writeFileSync(join(dir, 'escape.js'), 'export function register() {}');
    writeModule(root, 'evil', {
      name: 'evil',
      version: '1.0.0',
      modulus: '*',
      entrypoints: { tools: '../../escape.js' },
    });
    const loader = createModuleLoader({
      roots: [root],
      stateRoot: join(dir, 'state'),
      db,
      llm: fakeLlm,
      log,
      scheduler: createScheduler({ log }),
      tools: createToolRegistry({ log }),
      hostVersion: '0.0.0',
      chatId: 0,
      watch: false,
    });
    await loader.loadAll();
    const entry = loader.list().find((e) => e.name === 'evil');
    assert.ok(entry, 'module entry should be present even on failure');
    assert.match(entry!.error ?? '', /escapes module folder/);
    db.close();
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows can hold SQLite WAL handles briefly after close() */
    }
  }
});

test('S2: oversized intent_pattern is ignored, not compiled', async () => {
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    const root = join(dir, 'exts');
    mkdirSync(root);
    // 300-char pattern: well past the 256-char cap. If the cap were absent
    // the pattern would compile and match the message below.
    const pattern = 'a'.repeat(300);
    writeModule(
      root,
      'bigpat',
      {
        name: 'bigpat',
        version: '1.0.0',
        modulus: '*',
        intent_pattern: pattern,
        entrypoints: { tools: './tools.js' },
      },
      {
        'tools.js':
          'export function register(host) {\n' +
          "  host.tools.register({ name: 'noop', description: '', parameters: {}, tier: 'auto', invoke: async () => '' });\n" +
          '}\n',
      },
    );
    const loader = createModuleLoader({
      roots: [root],
      stateRoot: join(dir, 'state'),
      db,
      llm: fakeLlm,
      log,
      scheduler: createScheduler({ log }),
      tools: createToolRegistry({ log }),
      hostVersion: '0.0.0',
      chatId: 0,
      watch: false,
    });
    await loader.loadAll();
    // No module declared a usable pattern, so the orchestrator should fall
    // back to "all tools" (returns null), not the "patterns present but no
    // match" empty array. That fallback is what tells us the over-length
    // pattern was rejected at load time. Avoid all-same-char messages because
    // isLowSignalMessage() short-circuits to [] before patterns are checked.
    const matched = loader.relevantModules('please find me a recipe');
    assert.equal(matched, null);
    db.close();
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows can hold SQLite WAL handles briefly after close() */
    }
  }
});

test('S6: module state directory is created 0o700 on POSIX', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX mode bits do not apply on Windows');
    return;
  }
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    const root = join(dir, 'exts');
    const stateRoot = join(dir, 'state');
    mkdirSync(root);
    mkdirSync(stateRoot);
    writeModule(root, 'plain', { name: 'plain', version: '1.0.0', modulus: '*' });
    const loader = createModuleLoader({
      roots: [root],
      stateRoot,
      db,
      llm: fakeLlm,
      log,
      scheduler: createScheduler({ log }),
      tools: createToolRegistry({ log }),
      hostVersion: '0.0.0',
      chatId: 0,
      watch: false,
    });
    await loader.loadAll();
    const st = statSync(join(stateRoot, 'plain'));
    assert.equal(st.mode & 0o777, 0o700);
    db.close();
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows can hold SQLite WAL handles briefly after close() */
    }
  }
});
