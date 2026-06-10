// Distribution contract test: every shippable module must survive the real
// marketplace pipeline — pack with the docs/registry.md recipe, install via
// stageModule → commitModule into a fresh MODULUS_HOME, then load with the
// repo checkout nowhere on the resolution path.
//
// This is the test that catches the class of bug a repo-checkout smoke test
// can't: a module that works from <repo>/modules because a runtime import
// reaches into ../../src (or because a heavy npm package happens to be
// hoisted at the repo root) but breaks the moment a real user clicks
// "Install" and the module lands in ~/.modulus/modules instead. Type-only
// imports are fine (erased at transpile time); runtime imports outside the
// module folder are exactly what this test refuses.
//
// Setup entrypoints are imported (never invoked — invoking would run real
// npm installs and browser downloads) because the enable/install flow
// imports them from the installed location too (src/cli/ext-setup.ts).

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { open } from '../storage/db.js';
import { createLogger } from '../util/log.js';
import { createScheduler } from './scheduler.js';
import { createToolRegistry } from './tools.js';
import { createModuleLoader, type Manifest, type SetupEntrypointModule } from './modules.js';
import { commitModule, parseRegistryEntry, stageModule, type FetchLike } from './installer.js';
import { HOST_VERSION } from './version.js';
import type { LLM, ProfileConfig, ProfileName } from './llm.js';

const log = createLogger({ level: 'error', out: () => {}, err: () => {} });

const REPO_MODULES_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'modules');

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

// -- ustar packer (the docs/registry.md recipe, in-process) ------------------
// Mirrors `tar --format=ustar -czf <name>.tgz -C modules <name>`: plain ustar
// headers, every entry under a single `<name>/` prefix, paths ≤ 100 bytes,
// no symlinks. The strict extractor in installer.ts is the consumer; packing
// anything it would reject is a publishing bug we want to fail here.

function tarHeader(name: string, size: number, type: string): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100); // mode
  h.write('0000000\0', 108); // uid
  h.write('0000000\0', 116); // gid
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136); // mtime
  h.write('        ', 148); // checksum placeholder (spaces)
  h.write(type, 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i]!;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}

interface TarEntry {
  name: string;
  data?: Buffer; // absent = directory
}

function packModuleFolder(moduleDir: string, name: string): Buffer {
  const entries: TarEntry[] = [{ name: `${name}/` }];
  const walk = (dir: string, relPrefix: string): void => {
    const dirents = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const d of dirents) {
      // node_modules is local enable-time state (module-local npm deps); a
      // clean registry-CI checkout never contains it, so packing it would
      // make the test depend on this machine's history.
      if (d.name === 'node_modules') continue;
      const abs = join(dir, d.name);
      const rel = `${relPrefix}${d.name}`;
      if (d.isSymbolicLink()) {
        throw new Error(`symlink in module folder (the strict extractor refuses these): ${rel}`);
      }
      if (d.isDirectory()) {
        entries.push({ name: `${rel}/` });
        walk(abs, `${rel}/`);
      } else if (d.isFile()) {
        entries.push({ name: rel, data: readFileSync(abs) });
      }
    }
  };
  walk(moduleDir, `${name}/`);

  const parts: Buffer[] = [];
  for (const e of entries) {
    // Plain ustar carries ≤ 100-byte names; the registry contract says keep
    // layouts shallow rather than emit pax/gnu long-name records.
    assert.ok(
      Buffer.byteLength(e.name, 'utf8') <= 100,
      `tar path exceeds the ustar 100-byte limit (docs/registry.md): ${e.name}`,
    );
    if (e.data === undefined) {
      parts.push(tarHeader(e.name, 0, '5'));
    } else {
      parts.push(tarHeader(e.name, e.data.length, '0'));
      const padded = Buffer.alloc(Math.ceil(e.data.length / 512) * 512);
      e.data.copy(padded);
      parts.push(padded);
    }
  }
  parts.push(Buffer.alloc(1024)); // end-of-archive
  return gzipSync(Buffer.concat(parts));
}

function sha(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function fakeFetch(bodies: Record<string, Buffer>): FetchLike {
  return async (url) => {
    const body = bodies[url];
    return {
      ok: !!body,
      status: body ? 200 : 404,
      headers: { get: () => null },
      arrayBuffer: async () => {
        const ab = new ArrayBuffer(body!.byteLength);
        new Uint8Array(ab).set(body!);
        return ab;
      },
    };
  };
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
      await new Promise((r) => setTimeout(r, 100));
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

// A load failure is acceptable ONLY when it's a missing *bare* npm package —
// the heavy, opt-in dependency a module's setup entrypoint installs into its
// own node_modules at enable time (playwright, discord.js, @discordjs/voice…),
// which this clean-home test never runs. A relative specifier ('../../src/…',
// './foo.js') means the module reached for a path that isn't there once
// installed — the A-1 class of bug this whole test exists to catch.
function isMissingHeavyDep(error: string): boolean {
  const m = /Cannot find (?:module|package) ['"]([^'"]+)['"]/.exec(error);
  if (!m) return false;
  const spec = m[1]!;
  return !spec.startsWith('.') && !spec.includes('src/');
}

// Every module folder in the repo except the dev-only eval harness, which is
// not published to the registry (it exists to test the host, not extend it).
function shippableModuleNames(): string[] {
  return readdirSync(REPO_MODULES_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(REPO_MODULES_ROOT, d.name, 'manifest.json')))
    .map((d) => d.name)
    .filter((n) => n !== 'modulus-abilitytest')
    .sort();
}

test('every shippable module survives pack → install → load from a clean home', async () => {
  const names = shippableModuleNames();
  // 8 at the time of writing. A drop means discovery broke or a module
  // vanished; growth is fine and covered automatically.
  assert.ok(names.length >= 8, `expected at least 8 shippable modules, found ${names.length}`);

  const home = mkdtempSync(join(tmpdir(), 'modulus-dist-'));
  const failures: string[] = [];
  let db: ReturnType<typeof open> | undefined;
  try {
    const modulesRoot = join(home, 'modules');

    // Pack + stage + commit each module exactly as the marketplace does.
    for (const name of names) {
      const folder = join(REPO_MODULES_ROOT, name);
      const manifest = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')) as Manifest;
      const tgz = packModuleFolder(folder, name);
      const entry = parseRegistryEntry({
        name,
        version: manifest.version,
        tarball: `https://registry.test/${name}-${manifest.version}.tgz`,
        sha256: sha(tgz),
        permissions: manifest.permissions ?? {},
      });
      const staged = await stageModule(entry, {
        stagingRoot: join(home, 'staging'),
        hostVersion: HOST_VERSION,
        fetchImpl: fakeFetch({ [entry.tarball]: tgz }),
      });
      const dest = commitModule(staged, modulesRoot);
      assert.ok(existsSync(join(dest, 'manifest.json')), `${name}: committed without a manifest`);
    }

    // Load everything from the installed location only. The repo's modules/
    // root is deliberately NOT in roots: resolution must succeed from the
    // committed copies alone.
    db = open({ path: join(home, 'modulus.db'), log });
    const tools = createToolRegistry({ log });
    const sched = createScheduler({ log });
    const loader = createModuleLoader({
      roots: [modulesRoot],
      stateRoot: join(home, 'module-state'),
      db,
      llm: fakeLlm,
      log,
      scheduler: sched,
      tools,
      hostVersion: HOST_VERSION,
      chatId: 0,
      watch: false,
    });
    try {
      await loader.loadAll();

      const byName = new Map(loader.list().map((e) => [e.name, e]));
      for (const name of names) {
        const entry = byName.get(name);
        if (!entry) {
          failures.push(`${name}: not discovered after install`);
          continue;
        }
        if (!entry.enabled) failures.push(`${name}: unexpectedly disabled on first load`);
        if (entry.error && !isMissingHeavyDep(entry.error)) {
          // A relative/host-path specifier ('../../src/…') is the A-1 bug:
          // the installed copy has no src/ tree to reach into. A *bare*
          // missing package is the heavy opt-in dep the module's setup
          // installs into <module>/node_modules at enable time — not run in
          // this clean-home test, so tolerate it. The distinction is exactly
          // the boundary 1.1 protects.
          failures.push(`${name}: load error — ${entry.error}`);
        }
      }

      // The enable/install flow dynamic-imports the setup entrypoint from the
      // installed folder too — it must import (not run) cleanly from there.
      for (const name of names) {
        const manifest = JSON.parse(
          readFileSync(join(modulesRoot, name, 'manifest.json'), 'utf8'),
        ) as Manifest;
        const rel = manifest.entrypoints?.setup;
        if (!rel) continue;
        const setupPath = join(modulesRoot, name, rel);
        try {
          const mod = (await import(pathToFileURL(setupPath).href)) as SetupEntrypointModule;
          if (typeof (mod.setup ?? mod.run) !== 'function') {
            failures.push(`${name}: setup entrypoint exports no setup(ctx)/run(ctx)`);
          }
        } catch (e) {
          failures.push(
            `${name}: setup entrypoint failed to import from the installed location — ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
        }
      }
    } finally {
      await loader.shutdown();
    }

    assert.deepEqual(
      failures,
      [],
      `modules broken when installed from a tarball (works-from-repo-checkout does not count):\n  ${failures.join('\n  ')}`,
    );
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
    await rmTempDir(home);
  }
});
