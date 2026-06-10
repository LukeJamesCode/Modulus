import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { open, type DB } from '../../storage/db.js';
import { createLogger } from '../../util/log.js';
import { userModulesRoot } from '../../cli/module-paths.js';
import type { FetchLike } from '../../core/installer.js';
import type { PanelDeps } from '../types.js';
import { browseRegistry, installFromRegistry } from './marketplace.js';

const log = createLogger({ level: 'error', out: () => {}, err: () => {} });

// -- minimal ustar tar builder (mirrors installer.test.ts) ------------------
function tarHeader(name: string, size: number, type: string): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write(type, 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i]!;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}
function tarEntry(name: string, content: string): Buffer {
  const data = Buffer.from(content, 'utf8');
  const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
  data.copy(padded);
  return Buffer.concat([tarHeader(name, data.length, '0'), padded]);
}
function buildTgz(name: string, version: string): Buffer {
  const manifest = JSON.stringify({ name, version, modulus: '*' });
  return gzipSync(
    Buffer.concat([
      tarEntry('manifest.json', manifest),
      tarEntry('tools.js', 'export function register() {}'),
      Buffer.alloc(1024),
    ]),
  );
}
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

const INDEX_URL = 'https://reg.test/index.json';
const TARBALL = 'https://reg.test/modulus-demo-1.0.0.tgz';

// Serves the index JSON + tarball bytes through one FetchLike.
function fakeFetch(bodies: Record<string, Buffer>): FetchLike {
  return async (url) => {
    const body = bodies[url];
    return {
      ok: body !== undefined,
      status: body !== undefined ? 200 : 404,
      headers: { get: () => null },
      arrayBuffer: async () => {
        const ab = new ArrayBuffer(body!.byteLength);
        new Uint8Array(ab).set(body!);
        return ab;
      },
    };
  };
}

function indexJson(entries: unknown[]): Buffer {
  return Buffer.from(JSON.stringify(entries), 'utf8');
}

interface Harness {
  deps: PanelDeps;
  reloads: string[];
  home: string;
  cleanup: () => void;
}

function harness(): Harness {
  const home = mkdtempSync(join(tmpdir(), 'modulus-mkt-'));
  const db: DB = open({ path: join(home, 'modulus.db'), log });
  const reloads: string[] = [];
  const deps = {
    db,
    log,
    home,
    moduleRoots: [userModulesRoot(home)],
    loader: {
      reload: async (name: string) => void reloads.push(name),
    },
  } as unknown as PanelDeps;
  return {
    deps,
    reloads,
    home,
    cleanup: () => {
      db.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test('browse decorates entries with installed + update state', async () => {
  const h = harness();
  try {
    const tgz = buildTgz('modulus-demo', '1.0.0');
    const entry = {
      name: 'modulus-demo',
      version: '1.0.0',
      tarball: TARBALL,
      sha256: sha(tgz),
      description: 'A demo',
      permissions: { network: ['demo.test'] },
    };
    const fetchImpl = fakeFetch({ [INDEX_URL]: indexJson([entry]), [TARBALL]: tgz });
    const opts = { fetchImpl, registryUrl: INDEX_URL };

    const before = await browseRegistry(h.deps, opts);
    assert.equal(before.modules.length, 1);
    assert.equal(before.modules[0]!.installed, false);
    assert.deepEqual(before.modules[0]!.permissions, ['Can contact demo.test on the internet']);

    // Install (consent the network permission), then browse sees it installed.
    const r = await installFromRegistry(h.deps, { name: 'modulus-demo', acceptAdded: true }, opts);
    assert.equal(r.status, 200);
    const after = await browseRegistry(h.deps, opts);
    assert.equal(after.modules[0]!.installed, true);
    assert.equal(after.modules[0]!.installedVersion, '1.0.0');
    assert.equal(after.modules[0]!.updateAvailable, false);
  } finally {
    h.cleanup();
  }
});

test('install with new permissions is blocked until consent (409), then succeeds', async () => {
  const h = harness();
  try {
    const tgz = buildTgz('modulus-demo', '1.0.0');
    const entry = {
      name: 'modulus-demo',
      version: '1.0.0',
      tarball: TARBALL,
      sha256: sha(tgz),
      permissions: { subprocess: ['ffmpeg'] },
    };
    const opts = {
      fetchImpl: fakeFetch({ [INDEX_URL]: indexJson([entry]), [TARBALL]: tgz }),
      registryUrl: INDEX_URL,
    };

    const blocked = await installFromRegistry(h.deps, { name: 'modulus-demo' }, opts);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body['needsConsent'], true);
    assert.deepEqual(blocked.body['added'], ['Can run the program "ffmpeg" on this computer']);
    // Nothing installed, nothing hot-loaded while consent is pending.
    assert.equal(existsSync(join(userModulesRoot(h.home), 'modulus-demo')), false);
    assert.equal(h.reloads.length, 0);

    const ok = await installFromRegistry(h.deps, { name: 'modulus-demo', acceptAdded: true }, opts);
    assert.equal(ok.status, 200);
    assert.equal(ok.body['ok'], true);
    // Committed to the live root, consent sidecar written, hot-reloaded.
    const dest = join(userModulesRoot(h.home), 'modulus-demo');
    assert.ok(existsSync(join(dest, 'manifest.json')));
    assert.deepEqual(JSON.parse(readFileSync(join(dest, '.modulus-consent.json'), 'utf8')), {
      subprocess: ['ffmpeg'],
    });
    assert.deepEqual(h.reloads, ['modulus-demo']);
  } finally {
    h.cleanup();
  }
});

test('a no-permission module installs without a consent round-trip', async () => {
  const h = harness();
  try {
    const tgz = buildTgz('modulus-plain', '1.0.0');
    const tarball = 'https://reg.test/modulus-plain.tgz';
    const entry = { name: 'modulus-plain', version: '1.0.0', tarball, sha256: sha(tgz) };
    const opts = {
      fetchImpl: fakeFetch({ [INDEX_URL]: indexJson([entry]), [tarball]: tgz }),
      registryUrl: INDEX_URL,
    };
    const r = await installFromRegistry(h.deps, { name: 'modulus-plain' }, opts);
    assert.equal(r.status, 200);
    assert.deepEqual(h.reloads, ['modulus-plain']);
  } finally {
    h.cleanup();
  }
});

test('an unknown module name is 404', async () => {
  const h = harness();
  try {
    const opts = { fetchImpl: fakeFetch({ [INDEX_URL]: indexJson([]) }), registryUrl: INDEX_URL };
    const r = await installFromRegistry(h.deps, { name: 'ghost' }, opts);
    assert.equal(r.status, 404);
    assert.equal(h.reloads.length, 0);
  } finally {
    h.cleanup();
  }
});

test('a tarball whose sha256 does not match the index is refused (400)', async () => {
  const h = harness();
  try {
    const tgz = buildTgz('modulus-demo', '1.0.0');
    const tampered = buildTgz('modulus-demo', '1.0.0-evil'); // different bytes, same name
    const entry = {
      name: 'modulus-demo',
      version: '1.0.0',
      tarball: TARBALL,
      sha256: sha(tgz), // index pins the GOOD hash
    };
    const opts = {
      // ...but the server is served the TAMPERED bytes.
      fetchImpl: fakeFetch({ [INDEX_URL]: indexJson([entry]), [TARBALL]: tampered }),
      registryUrl: INDEX_URL,
    };
    const r = await installFromRegistry(h.deps, { name: 'modulus-demo' }, opts);
    assert.equal(r.status, 400);
    assert.match(String(r.body['error']), /sha256 mismatch/);
    assert.equal(existsSync(join(userModulesRoot(h.home), 'modulus-demo')), false);
  } finally {
    h.cleanup();
  }
});

test('an unreachable registry surfaces as 502, not an empty marketplace', async () => {
  const h = harness();
  try {
    const opts = { fetchImpl: fakeFetch({}), registryUrl: INDEX_URL }; // index 404s
    const r = await installFromRegistry(h.deps, { name: 'x' }, opts);
    assert.equal(r.status, 502);
    await assert.rejects(browseRegistry(h.deps, opts));
  } finally {
    h.cleanup();
  }
});
