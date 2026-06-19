// Module tripwire tests. The tripwires enforce a module's DECLARED permissions
// at runtime so the consent screen stays truthful. What matters:
// - matching is correct per surface: network (exact + parent-domain + '*'),
//   subprocess (binary basename), filesystem (lexical containment)
// - a non-allowlisted call throws and is COUNTED (the denied counter), while an
//   allowlisted call goes through
// - the loader wires host.fetch/spawn/fs and surfaces the denial counter
// - a CI guard keeps NEW first-party modules off direct node:child_process

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { open } from '../storage/db.js';
import { createLogger } from '../util/log.js';
import { createScheduler } from './scheduler.js';
import { createToolRegistry } from './tools.js';
import { createModuleLoader, type ModuleLoaderOptions } from './modules.js';
import {
  hostMatchesAllowlist,
  binaryAllowed,
  pathContained,
  createModuleTripwires,
  TripwireError,
  type TripwireSurface,
} from './module-tripwires.js';
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

// -- matching primitives -----------------------------------------------------

test('hostMatchesAllowlist: exact, parent-domain, wildcard, and the dot boundary', () => {
  assert.equal(hostMatchesAllowlist('api.example.com', ['api.example.com']), true);
  assert.equal(hostMatchesAllowlist('api.example.com', ['example.com']), true); // parent
  assert.equal(hostMatchesAllowlist('example.com', ['example.com']), true);
  assert.equal(hostMatchesAllowlist('notexample.com', ['example.com']), false); // dot boundary
  assert.equal(hostMatchesAllowlist('evil.com', ['example.com']), false);
  assert.equal(hostMatchesAllowlist('anything.net', ['*']), true);
  // Entries may be full URLs or host:port — only the host is compared.
  assert.equal(hostMatchesAllowlist('api.example.com', ['https://example.com/v1']), true);
  assert.equal(hostMatchesAllowlist('example.com', ['example.com:443']), true);
});

test('binaryAllowed: basename match, .exe tolerance, and wildcard', () => {
  assert.equal(binaryAllowed('ffmpeg', ['ffmpeg']), true);
  assert.equal(binaryAllowed('/usr/bin/ffmpeg', ['ffmpeg']), true);
  assert.equal(binaryAllowed('C:\\tools\\ffmpeg.exe', ['ffmpeg']), true);
  assert.equal(binaryAllowed('rm', ['ffmpeg']), false);
  assert.equal(binaryAllowed('whatever', ['*']), true);
});

test('pathContained: a path inside a root passes; traversal and siblings fail', () => {
  const root = resolve('/srv/data');
  assert.equal(pathContained(join(root, 'a/b.txt'), [root]), true);
  assert.equal(pathContained(root, [root]), true);
  assert.equal(pathContained(resolve(root, '../other/x'), [root]), false);
  assert.equal(pathContained(resolve('/srv/datax/y'), [root]), false); // prefix, not child
});

// -- createModuleTripwires: enforcement + the denied counter -----------------

function countingTripwires(
  permissions: {
    network?: string[];
    subprocess?: string[];
    filesystem?: string[];
  },
  dataDir: string,
) {
  const denials: TripwireSurface[] = [];
  const tw = createModuleTripwires({
    moduleName: 'demo',
    permissions,
    dataDir,
    log,
    onDenied: (s) => denials.push(s),
  });
  return { tw, denials };
}

test('host.fetch: allowlisted host passes, others throw and are counted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-'));
  const realFetch = globalThis.fetch;
  try {
    // Stub global fetch so the allowed path doesn't hit the network.
    (globalThis as { fetch: unknown }).fetch = async () => ({ status: 200 }) as Response;
    const { tw, denials } = countingTripwires({ network: ['api.example.com'] }, dir);
    const ok = await tw.fetch('https://api.example.com/v1/x');
    assert.equal((ok as { status: number }).status, 200);
    assert.equal(denials.length, 0);

    await assert.rejects(() => tw.fetch('https://evil.test/steal'), TripwireError);
    assert.deepEqual(denials, ['network']);
  } finally {
    (globalThis as { fetch: unknown }).fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('host.spawn: allowlisted binary runs, others throw and are counted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-'));
  try {
    const { tw, denials } = countingTripwires({ subprocess: ['node'] }, dir);
    // process.execPath is node; basename normalises to 'node'.
    const child = tw.spawn(process.execPath, ['-e', 'process.exit(0)']);
    await new Promise<void>((res) => child.on('close', () => res()));
    assert.equal(denials.length, 0);

    assert.throws(() => tw.spawn('rm', ['-rf', '/']), TripwireError);
    assert.deepEqual(denials, ['subprocess']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('host.fs: writes inside the dataDir, denies paths outside the allowed roots', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-'));
  const outside = mkdtempSync(join(tmpdir(), 'tw-out-'));
  try {
    const { tw, denials } = countingTripwires({}, dir);
    await tw.fs.writeFile('note.txt', 'hello');
    assert.equal(await tw.fs.readTextFile('note.txt'), 'hello');
    assert.equal(tw.fs.exists('note.txt'), true);
    assert.equal(denials.length, 0);

    await assert.rejects(() => tw.fs.readTextFile(join(outside, 'secret')), TripwireError);
    assert.throws(() => tw.fs.exists(join(outside, 'secret')), TripwireError);
    assert.deepEqual(denials, ['filesystem', 'filesystem']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('host.fs honours an extra consented filesystem root', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-'));
  const extra = mkdtempSync(join(tmpdir(), 'tw-extra-'));
  try {
    const { tw, denials } = countingTripwires({ filesystem: [extra] }, dir);
    await tw.fs.writeFile(join(extra, 'ok.txt'), 'x');
    assert.equal(await tw.fs.readTextFile(join(extra, 'ok.txt')), 'x');
    assert.equal(denials.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(extra, { recursive: true, force: true });
  }
});

// -- loader integration: host wiring + the surfaced counter ------------------

test('the loader wires host.fetch and surfaces tripwire denials per module', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tw-loader-'));
  const modFolder = join(root, 'exts', 'demo-net');
  mkdirSync(modFolder, { recursive: true });
  writeFileSync(
    join(modFolder, 'manifest.json'),
    JSON.stringify({
      name: 'demo-net',
      version: '1.0.0',
      modulus: '*',
      entrypoints: { tools: './tools.js' },
      permissions: { network: ['api.allowed.test'] },
    }),
  );
  writeFileSync(
    join(modFolder, 'tools.js'),
    `export function register(host) {
      host.tools.register({
        name: 'probe_fetch',
        description: 'fetch probe',
        tier: 'auto',
        parameters: { type: 'object', properties: { url: { type: 'string' } } },
        invoke: async (args) => {
          const res = await host.fetch(args.url);
          return 'fetched:' + res.status;
        },
      });
    }`,
  );

  const db = open({ path: join(root, 'g.db'), log });
  const tools = createToolRegistry({ log });
  const realFetch = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = async () => ({ status: 200 }) as Response;
  const opts: ModuleLoaderOptions = {
    roots: [join(root, 'exts')],
    stateRoot: join(root, 'state'),
    db,
    llm: fakeLlm,
    log,
    scheduler: createScheduler({ log, dispatch: () => {} }),
    tools,
    hostVersion: '1.5.0',
    chatId: 0,
    watch: false,
  };
  const loader = createModuleLoader(opts);
  try {
    await loader.loadAll();
    const allowed = await tools.execute(
      { id: '1', name: 'probe_fetch', arguments: { url: 'https://api.allowed.test/x' } },
      { log },
    );
    assert.equal(allowed.ok, true);
    assert.equal(allowed.output, 'fetched:200');
    assert.deepEqual(loader.tripwireDenials(), {});

    const denied = await tools.execute(
      { id: '2', name: 'probe_fetch', arguments: { url: 'https://evil.test/x' } },
      { log },
    );
    assert.equal(denied.ok, false);
    assert.equal(loader.tripwireDenials()['demo-net'], 1);
  } finally {
    (globalThis as { fetch: unknown }).fetch = realFetch;
    await loader.shutdown();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// -- CI guard: no NEW direct node:child_process in first-party modules -------

// These files predate the tripwires and legitimately spawn heavy binaries
// (ffmpeg / whisper / playwright) or run install tooling during enable. New
// module code must reach subprocesses through host.spawn so the declared
// subprocess allowlist is enforced; add a file here only with that justification.
const CHILD_PROCESS_GRANDFATHER = new Set([
  'modulus-voice/setup.ts',
  'modulus-voice/synth.ts',
  'modulus-voice/stt.ts',
  'modulus-voice/shell.ts',
  'modulus-browser/setup.ts',
  'modulus-discord/lib/voice.ts',
]);

test('no NEW first-party module imports node:child_process directly', () => {
  const modulesRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..', 'modules');
  if (!existsSync(modulesRoot)) return; // packaged build without sources — nothing to scan
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        const src = readFileSync(full, 'utf8');
        if (
          /(from\s+['"](?:node:)?child_process['"]|require\(\s*['"](?:node:)?child_process['"]\s*\))/.test(
            src,
          )
        ) {
          offenders.push(relative(modulesRoot, full).split('\\').join('/'));
        }
      }
    }
  };
  walk(modulesRoot);
  const unexpected = offenders.filter((f) => !CHILD_PROCESS_GRANDFATHER.has(f));
  assert.deepEqual(
    unexpected,
    [],
    `New direct child_process import(s) — route subprocesses through host.spawn instead: ${unexpected.join(', ')}`,
  );
});
