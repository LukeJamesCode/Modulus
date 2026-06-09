import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../storage/db.js';
import { createLogger } from '../util/log.js';
import { createScheduler } from './scheduler.js';
import { createToolRegistry } from './tools.js';
import { createExtensionLoader, satisfiesModulusRange } from './extensions.js';
import type { LLM, ProfileConfig, ProfileName } from './llm.js';

const log = createLogger({ level: 'error', out: () => {}, err: () => {} });

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'modulus-ext-'));
}

const fakeLlm: LLM = {
  // Tests don't exercise the LLM path; satisfy the interface.
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

function writeExt(
  root: string,
  name: string,
  manifest: Record<string, unknown>,
  files: Record<string, string> = {},
): string {
  const folder = join(root, name);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'manifest.json'), JSON.stringify(manifest, null, 2));
  for (const [path, content] of Object.entries(files)) {
    const abs = join(folder, path);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  return folder;
}

async function waitFor(
  assertion: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(await assertion(), 'condition did not become true before timeout');
}

// Hot-reload re-imports an extension entrypoint with a cache-busting query
// string (see importEntrypoint in extensions.ts). Native Node's ESM loader
// honors that query and returns the fresh module, so the content reload below
// works in production. The test harness, however, runs under tsx
// (`node --import tsx/dist/loader.mjs`), whose loader transforms and caches
// `.js` entrypoints by resolved path and ignores the query — a content change
// is never observed, so this one assertion can't pass there. Detection and
// teardown on reload are exercised by the sibling reload tests regardless of
// loader; only the "does the new code take effect" assertion is loader-bound.
function dynamicImportCacheBustWorks(): boolean {
  return !process.execArgv.some((a) => /tsx/i.test(a));
}

async function rmTempDir(dir: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      lastError = e;
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'ENOTEMPTY') throw e;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (
    process.platform === 'win32' &&
    ['EBUSY', 'EPERM', 'ENOTEMPTY'].includes((lastError as NodeJS.ErrnoException).code ?? '')
  ) {
    return;
  }
  throw lastError;
}

test('satisfiesModulusRange handles common cases', () => {
  assert.equal(satisfiesModulusRange('0.1.0', '>=0.1.0'), true);
  assert.equal(satisfiesModulusRange('0.0.9', '>=0.1.0'), false);
  assert.equal(satisfiesModulusRange('1.2.3', '>=0.1.0'), true);
  assert.equal(satisfiesModulusRange('0.1.0', '*'), true);
  assert.equal(satisfiesModulusRange('0.1.0', '0.1.0'), true);
  assert.equal(satisfiesModulusRange('0.1.1', '0.1.0'), false);
});

test('loader: discovers extension, runs migrations, registers tool/command/job/auth/prompt', async () => {
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    const tools = createToolRegistry({ log });
    const sched = createScheduler({ log });
    const root = join(dir, 'exts');
    mkdirSync(root);
    const stateRoot = join(dir, 'state');
    mkdirSync(stateRoot);

    // Write a self-contained extension with all entrypoints.
    const extFolder = writeExt(
      root,
      'demo',
      {
        name: 'demo',
        version: '1.0.0',
        modulus: '>=0.0.0',
        capabilities: ['network'],
        entrypoints: {
          tools: './tools.js',
          commands: './commands.js',
          jobs: './jobs.js',
          auth: './auth.js',
        },
      },
      {
        'prompt.md': 'You can do demo things.',
        'settings.schema.json': JSON.stringify({
          type: 'object',
          properties: { greeting: { type: 'string', default: 'hello' } },
        }),
        'migrations/0001_init.sql': 'CREATE TABLE demo_seen (id INTEGER PRIMARY KEY);',
        'tools.js':
          'export function register(host) {\n' +
          "  host.tools.register({ name: 'demo_echo', description: 'd', parameters: {}, tier: 'auto', invoke: async () => 'ok' });\n" +
          '}\n',
        'commands.js':
          'export function register(host) {\n' +
          "  host.telegram.command('demo', async (ctx) => { await ctx.reply('hi from demo'); }, 'Demo command');\n" +
          '  host.telegram.intercept(async (ctx) => { await ctx.next(); });\n' +
          '  host.telegram.afterTurn(async () => {});\n' +
          '}\n',
        'jobs.js':
          'export function register(host) {\n' +
          "  host.scheduler.cron('sweep', '*/5 * * * *', async () => []);\n" +
          "  host.prompts.contribute('Demo prompt fragment.');\n" +
          '}\n',
        'auth.js':
          'export function register(host) {\n' +
          "  host.auth.flow({ label: 'Demo auth', run: async (io) => ({ token: await io.prompt('Token?', { secret: true }) }) });\n" +
          '}\n',
      },
    );
    void extFolder;

    const loader = createExtensionLoader({
      roots: [root],
      stateRoot,
      db,
      llm: fakeLlm,
      log,
      scheduler: sched,
      tools,
      hostVersion: '0.0.0',
      chatId: 0,
      watch: false,
    });
    await loader.loadAll();

    const list = loader.list();
    assert.equal(list.length, 1);
    assert.equal(list[0]!.name, 'demo');
    assert.equal(list[0]!.error, undefined);

    // Tool registered
    assert.ok(tools.get('demo_echo'));

    // Command registered
    const cmds = loader.commands();
    assert.equal(cmds.length, 1);
    assert.equal(cmds[0]!.name, 'demo');

    // Intercept + auth + prompt
    assert.equal(loader.intercepts().length, 1);
    assert.equal(loader.afterTurns().length, 1);
    assert.equal(loader.authFlows().length, 1);
    assert.match(loader.promptFragment(), /Demo prompt fragment/);
    assert.match(loader.promptFragment(), /You can do demo things/);

    // Scheduler job registered
    assert.equal(sched.list().length, 1);

    // Per-extension migration applied — confirm the demo_seen table exists.
    const tablesBefore = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = 'demo_seen'")
      .all() as Array<{ name: string }>;
    assert.equal(tablesBefore.length, 1);

    // extension_state row created and enabled
    const state = db
      .prepare(`SELECT enabled, version FROM extension_state WHERE name = 'demo'`)
      .get() as { enabled: number; version: string };
    assert.equal(state.enabled, 1);
    assert.equal(state.version, '1.0.0');

    // unload: tool + scheduler + command should drop
    await loader.unload('demo');
    assert.equal(tools.get('demo_echo'), undefined);
    assert.equal(sched.list().length, 0);
    assert.equal(loader.commands().length, 0);
    assert.equal(loader.afterTurns().length, 0);

    await loader.shutdown();
    db.close();
  } finally {
    await rmTempDir(dir);
  }
});

test('host.telegram.onCallback: registers handler, exposed via loader.callbacks(), torn down on unload', async () => {
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    const tools = createToolRegistry({ log });
    const sched = createScheduler({ log });
    const root = join(dir, 'exts');
    mkdirSync(root);
    writeExt(
      root,
      'cbdemo',
      {
        name: 'cbdemo',
        version: '1.0.0',
        modulus: '*',
        entrypoints: { tools: './tools.js' },
      },
      {
        'tools.js':
          'export function register(host) {\n' +
          "  host.telegram.onCallback('demoP', async (ctx) => { await ctx.ack('ok'); });\n" +
          '}\n',
      },
    );

    const loader = createExtensionLoader({
      roots: [root],
      stateRoot: join(dir, 'state'),
      db,
      llm: fakeLlm,
      log,
      scheduler: sched,
      tools,
      hostVersion: '0.0.0',
      chatId: 0,
      watch: false,
    });
    await loader.loadAll();

    const cbs = loader.callbacks();
    assert.equal(cbs.length, 1, 'one callback handler should be registered');
    assert.equal(cbs[0]!.prefix, 'demoP');
    assert.equal(cbs[0]!.extension, 'cbdemo');

    await loader.unload('cbdemo');
    assert.equal(
      loader.callbacks().length,
      0,
      'unload should remove the registered callback handler',
    );
    await loader.shutdown();
    db.close();
  } finally {
    await rmTempDir(dir);
  }
});

test('host.telegram.onCallback: rejects prefixes with characters that break dispatch', async () => {
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    const tools = createToolRegistry({ log });
    const sched = createScheduler({ log });
    const root = join(dir, 'exts');
    mkdirSync(root);
    // A prefix containing ':' would be ambiguous with the dispatcher's split.
    writeExt(
      root,
      'badcb',
      {
        name: 'badcb',
        version: '1.0.0',
        modulus: '*',
        entrypoints: { tools: './tools.js' },
      },
      {
        'tools.js':
          'export function register(host) {\n' +
          "  host.telegram.onCallback('bad:prefix', async () => {});\n" +
          '}\n',
      },
    );

    const loader = createExtensionLoader({
      roots: [root],
      stateRoot: join(dir, 'state'),
      db,
      llm: fakeLlm,
      log,
      scheduler: sched,
      tools,
      hostVersion: '0.0.0',
      chatId: 0,
      watch: false,
    });
    await loader.loadAll();
    // Loader catches the throw and records it as a load error; nothing is
    // registered. Either way, callbacks() should be empty.
    assert.equal(loader.callbacks().length, 0);
    db.close();
  } finally {
    await rmTempDir(dir);
  }
});

test('loader: rejects extension whose modulus range exceeds host version', async () => {
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    const tools = createToolRegistry({ log });
    const sched = createScheduler({ log });
    const root = join(dir, 'exts');
    mkdirSync(root);
    writeExt(root, 'too-new', { name: 'too-new', version: '1.0.0', modulus: '>=99.0.0' });
    const loader = createExtensionLoader({
      roots: [root],
      stateRoot: join(dir, 'state'),
      db,
      llm: fakeLlm,
      log,
      scheduler: sched,
      tools,
      hostVersion: '0.0.0',
      chatId: 0,
      watch: false,
    });
    await loader.loadAll();
    // Loader logs and skips — list is empty.
    assert.equal(loader.list().length, 0);
    db.close();
  } finally {
    await rmTempDir(dir);
  }
});

test('loader: disabled extension is recorded but not registered', async () => {
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    const tools = createToolRegistry({ log });
    const sched = createScheduler({ log });
    const root = join(dir, 'exts');
    mkdirSync(root);
    writeExt(
      root,
      'disabled',
      {
        name: 'disabled',
        version: '1.0.0',
        modulus: '*',
        entrypoints: { tools: './tools.js' },
      },
      {
        'tools.js':
          'export function register(host) {\n' +
          "  host.tools.register({ name: 'never', description: '', parameters: {}, tier: 'auto', invoke: async () => '' });\n" +
          '}\n',
      },
    );
    // Pre-create state row with enabled=0
    db.prepare(
      `INSERT INTO extension_state (name, version, enabled, installed_at) VALUES (?, ?, 0, ?)`,
    ).run('disabled', '1.0.0', Date.now());

    const loader = createExtensionLoader({
      roots: [root],
      stateRoot: join(dir, 'state'),
      db,
      llm: fakeLlm,
      log,
      scheduler: sched,
      tools,
      hostVersion: '0.1.0',
      chatId: 0,
      watch: false,
    });
    await loader.loadAll();
    assert.equal(loader.list().length, 1);
    assert.equal(loader.list()[0]!.enabled, false);
    assert.equal(tools.get('never'), undefined);
    db.close();
  } finally {
    await rmTempDir(dir);
  }
});

test('loader: settings reads defaults from schema and writes round-trip', async () => {
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    const tools = createToolRegistry({ log });
    const sched = createScheduler({ log });
    const root = join(dir, 'exts');
    mkdirSync(root);
    writeExt(
      root,
      'cfg',
      {
        name: 'cfg',
        version: '1.0.0',
        modulus: '*',
        entrypoints: { tools: './tools.js' },
      },
      {
        'settings.schema.json': JSON.stringify({
          type: 'object',
          properties: {
            count: { type: 'number', default: 7 },
            on: { type: 'boolean', default: true },
            label: { type: 'string', default: 'hi' },
          },
        }),
        'tools.js':
          'export function register(host) {\n' +
          "  host.tools.register({ name: 'cfg_dump', description: '', parameters: {}, tier: 'auto', invoke: async () => JSON.stringify(host.settings.all()) });\n" +
          "  host.settings.set('count', 42);\n" +
          '}\n',
      },
    );
    const loader = createExtensionLoader({
      roots: [root],
      stateRoot: join(dir, 'state'),
      db,
      llm: fakeLlm,
      log,
      scheduler: sched,
      tools,
      hostVersion: '0.1.0',
      chatId: 0,
      watch: false,
    });
    await loader.loadAll();
    const out = await tools.get('cfg_dump')!.invoke({}, { log });
    const parsed = JSON.parse(out) as Record<string, unknown>;
    assert.equal(parsed['count'], 42);
    assert.equal(parsed['on'], true);
    assert.equal(parsed['label'], 'hi');
    db.close();
  } finally {
    await rmTempDir(dir);
  }
});

test('loader: settings sees auth written outside the running extension host', async () => {
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    const tools = createToolRegistry({ log });
    const sched = createScheduler({ log });
    const root = join(dir, 'exts');
    mkdirSync(root);
    writeExt(
      root,
      'cfg',
      {
        name: 'cfg',
        version: '1.0.0',
        modulus: '*',
        entrypoints: { tools: './tools.js' },
      },
      {
        'settings.schema.json': JSON.stringify({
          type: 'object',
          properties: {
            google_refresh_token: { type: 'string', secret: true },
          },
        }),
        'tools.js':
          'export function register(host) {\n' +
          "  host.tools.register({ name: 'cfg_token', description: '', parameters: {}, tier: 'auto', invoke: async () => host.settings.get('google_refresh_token', '') });\n" +
          '}\n',
      },
    );
    const loader = createExtensionLoader({
      roots: [root],
      stateRoot: join(dir, 'state'),
      db,
      llm: fakeLlm,
      log,
      scheduler: sched,
      tools,
      hostVersion: '0.1.0',
      chatId: 0,
      watch: false,
    });
    await loader.loadAll();

    assert.equal(await tools.get('cfg_token')!.invoke({}, { log }), '');
    db.prepare(
      `INSERT INTO extension_settings (extension, key, value, updated_at)
       VALUES ('cfg', 'google_refresh_token', 'fresh-token', ?)`,
    ).run(Date.now());

    assert.equal(await tools.get('cfg_token')!.invoke({}, { log }), 'fresh-token');
    await loader.shutdown();
    sched.stop();
    db.close();
  } finally {
    await rmTempDir(dir);
  }
});

test('loader: intent filter skips trivial and low-signal messages', async () => {
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    const tools = createToolRegistry({ log });
    const sched = createScheduler({ log });
    const root = join(dir, 'exts');
    mkdirSync(root);
    writeExt(root, 'calendarish', {
      name: 'calendarish',
      version: '1.0.0',
      modulus: '*',
      intent_pattern: '\\b(calendar|events?)\\b',
    });
    writeExt(root, 'weatherish', {
      name: 'weatherish',
      version: '1.0.0',
      modulus: '*',
      intent_pattern: '\\b(weather|forecast)\\b',
    });

    const loader = createExtensionLoader({
      roots: [root],
      stateRoot: join(dir, 'state'),
      db,
      llm: fakeLlm,
      log,
      scheduler: sched,
      tools,
      hostVersion: '0.1.0',
      chatId: 0,
      watch: false,
    });
    await loader.loadAll();

    assert.deepEqual(loader.relevantExtensions('what is on my calendar?'), ['calendarish']);
    assert.deepEqual(loader.relevantExtensions('hi'), []);
    assert.deepEqual(loader.relevantExtensions('aaaaa'), []);
    assert.deepEqual(loader.relevantExtensions('???'), []);
    // Patterns exist but none match → skip tools entirely (chatter path).
    assert.deepEqual(loader.relevantExtensions('can you help me think this through?'), []);
    assert.deepEqual(loader.relevantExtensions('dang im tired today'), []);
    db.close();
  } finally {
    await rmTempDir(dir);
  }
});

test('loader: a mid-load throw rolls back tool/command/intercept/prompt fragments fully', async () => {
  // Regression for A1: previously only tools were unregistered on a partial
  // load failure, which left orphaned commands and prompt fragments in the
  // registry. With per-load disposers the rollback should be total — every
  // surface the failed extension touched is undone.
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    const tools = createToolRegistry({ log });
    const sched = createScheduler({ log });
    const root = join(dir, 'exts');
    mkdirSync(root);

    // The extension registers a tool, command, intercept, prompt fragment,
    // AND a scheduler job, then explodes from an auth-entrypoint throw.
    // After load all of that should be gone.
    writeExt(
      root,
      'broken',
      {
        name: 'broken',
        version: '1.0.0',
        modulus: '*',
        entrypoints: {
          tools: './tools.js',
          commands: './commands.js',
          jobs: './jobs.js',
          auth: './auth.js',
        },
      },
      {
        'tools.js':
          'export function register(host) {\n' +
          "  host.tools.register({ name: 'broken_tool', description: '', parameters: {}, tier: 'auto', invoke: async () => '' });\n" +
          '}\n',
        'commands.js':
          'export function register(host) {\n' +
          "  host.telegram.command('broken_cmd', async (ctx) => ctx.reply('x'));\n" +
          '  host.telegram.intercept(async (ctx) => ctx.next());\n' +
          '}\n',
        'jobs.js':
          'export function register(host) {\n' +
          "  host.scheduler.cron('broken_job', '*/5 * * * *', async () => []);\n" +
          "  host.prompts.contribute('Broken fragment.');\n" +
          '}\n',
        'auth.js':
          'export function register() {\n' + "  throw new Error('boom from auth');\n" + '}\n',
      },
    );

    const loader = createExtensionLoader({
      roots: [root],
      stateRoot: join(dir, 'state'),
      db,
      llm: fakeLlm,
      log,
      scheduler: sched,
      tools,
      hostVersion: '0.1.0',
      chatId: 0,
      watch: false,
    });
    await loader.loadAll();

    // Loader recorded the failure but rolled back every registry.
    const entry = loader.list().find((e) => e.name === 'broken');
    assert.ok(entry, 'broken extension should be tracked');
    assert.match(entry!.error ?? '', /boom from auth/);

    assert.equal(tools.get('broken_tool'), undefined, 'tool should be rolled back');
    assert.equal(loader.commands().length, 0, 'commands should be rolled back');
    assert.equal(loader.intercepts().length, 0, 'intercepts should be rolled back');
    assert.equal(loader.authFlows().length, 0, 'auth flows should be rolled back');
    assert.equal(sched.list().length, 0, 'scheduler jobs should be rolled back');
    // Prompt fragment must be gone — the orchestrator builds prompts from
    // this map every turn, so any leftover string is a real production bug.
    assert.equal(loader.promptFragment(), '');

    db.close();
  } finally {
    await rmTempDir(dir);
  }
});

test('host telegram knownChats exposes only allowlisted chats and default fallback', async () => {
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    const tools = createToolRegistry({ log });
    const sched = createScheduler({ log });
    const root = join(dir, 'exts');
    mkdirSync(root);

    db.prepare(
      `INSERT INTO telegram_chats (chat_id, user_id, devmode, last_seen_at) VALUES (?, ?, ?, ?)`,
    ).run(1001, 42, 0, 100);
    db.prepare(
      `INSERT INTO telegram_chats (chat_id, user_id, devmode, last_seen_at) VALUES (?, ?, ?, ?)`,
    ).run(-2002, 43, 1, 200);
    db.prepare(
      `INSERT INTO telegram_chats (chat_id, user_id, devmode, last_seen_at) VALUES (?, ?, ?, ?)`,
    ).run(9999, 99, 0, 300);

    writeExt(
      root,
      'chats-demo',
      {
        name: 'chats-demo',
        version: '1.0.0',
        modulus: '*',
        entrypoints: { commands: './commands.js' },
      },
      {
        'commands.js':
          'export function register(host) {\n' +
          "  host.telegram.command('chats', async (ctx) => {\n" +
          '    await ctx.reply(JSON.stringify({ defaultChatId: host.telegram.defaultChatId, chatId: host.telegram.chatId, known: host.telegram.knownChats() }));\n' +
          '  });\n' +
          '}\n',
      },
    );

    const loader = createExtensionLoader({
      roots: [root],
      stateRoot: join(dir, 'state'),
      db,
      llm: fakeLlm,
      log,
      scheduler: sched,
      tools,
      hostVersion: '0.1.0',
      chatId: 42,
      allowedUserIds: [42, 43],
      watch: false,
    });
    await loader.loadAll();

    let reply = '';
    await loader.commands()[0]!.handler({
      chatId: 1001,
      userId: 42,
      args: '',
      reply: async (text) => {
        reply = text;
      },
    });

    const payload = JSON.parse(reply) as {
      defaultChatId: number;
      chatId: number;
      known: Array<{ chatId: number; userId: number; devmode: boolean; lastSeenAt: number }>;
    };
    assert.equal(payload.defaultChatId, 42);
    assert.equal(payload.chatId, 42);
    assert.deepEqual(
      payload.known.map((chat) => chat.chatId),
      [-2002, 1001],
    );
    assert.deepEqual(
      payload.known.map((chat) => chat.userId),
      [43, 42],
    );
    assert.equal(payload.known[0]!.devmode, true);
    assert.equal(payload.known[0]!.lastSeenAt, 200);

    db.close();
  } finally {
    await rmTempDir(dir);
  }
});

test('loader: hot-reloads when a nested extension file changes', async (t) => {
  if (!dynamicImportCacheBustWorks()) {
    t.skip(
      'runtime loader ignores dynamic-import cache-busting (e.g. tsx); hot-reload is verified under native Node',
    );
    return;
  }
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    const tools = createToolRegistry({ log });
    const sched = createScheduler({ log });
    const root = join(dir, 'exts');
    mkdirSync(root);
    writeExt(
      root,
      'nested-reload',
      {
        name: 'nested-reload',
        version: '1.0.0',
        modulus: '*',
        entrypoints: { tools: './tools.js' },
      },
      {
        'tools.js':
          'export function register(host) {\n' +
          "  host.tools.register({ name: 'reload_value', description: '', parameters: {}, tier: 'auto', invoke: async () => 'v1' });\n" +
          '}\n',
      },
    );

    const loader = createExtensionLoader({
      roots: [root],
      stateRoot: join(dir, 'state'),
      db,
      llm: fakeLlm,
      log,
      scheduler: sched,
      tools,
      hostVersion: '0.1.0',
      chatId: 0,
      watch: true,
    });
    await loader.loadAll();
    assert.equal(await tools.get('reload_value')!.invoke({}, { log }), 'v1');

    writeFileSync(
      join(root, 'nested-reload', 'tools.js'),
      'export function register(host) {\n' +
        "  host.tools.register({ name: 'reload_value', description: '', parameters: {}, tier: 'auto', invoke: async () => 'v2' });\n" +
        '}\n',
    );
    await waitFor(async () => {
      const tool = tools.get('reload_value');
      return tool ? (await tool.invoke({}, { log })) === 'v2' : false;
    }, 5000);

    await loader.shutdown();
    db.close();
  } finally {
    await rmTempDir(dir);
  }
});
