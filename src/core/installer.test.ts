// Installer security tests. Each test encodes a refusal that protects a
// non-technical user clicking "Install":
// - a tampered tarball (sha mismatch) must never be unpacked
// - a tarball must not write outside its destination (zip-slip) or smuggle
//   symlinks/devices in
// - a tarball claiming a different module name than the index entry must be
//   refused (it could overwrite an installed module the user trusts)
// - updates that ADD permissions must be detectable for re-consent

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseRegistryIndex,
  parseRegistryEntry,
  downloadAndVerify,
  extractTarGz,
  stageModule,
  commitModule,
  permissionDiff,
  describePermissions,
  InstallError,
  type FetchLike,
  type RegistryIndexEntry,
} from './installer.js';

// -- minimal tar builder (test-only) ----------------------------------------

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

function tarEntry(name: string, content: string | null, type = '0'): Buffer {
  const data = content === null ? Buffer.alloc(0) : Buffer.from(content, 'utf8');
  const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
  data.copy(padded);
  return Buffer.concat([tarHeader(name, data.length, type), padded]);
}

function buildTgz(entries: Array<{ name: string; content: string | null; type?: string }>): Buffer {
  const parts = entries.map((e) => tarEntry(e.name, e.content, e.type ?? '0'));
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

function entryFor(tgz: Buffer, over: Partial<RegistryIndexEntry> = {}): RegistryIndexEntry {
  return {
    name: 'demo-mod',
    version: '1.0.0',
    tarball: 'https://example.test/demo-mod-1.0.0.tgz',
    sha256: sha(tgz),
    permissions: {},
    ...over,
  };
}

const GOOD_TGZ = buildTgz([
  { name: 'manifest.json', content: '{"name":"demo-mod","version":"1.0.0","modulus":"*"}' },
  { name: 'tools.js', content: 'export function register() {}' },
]);

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'modulus-installer-'));
}

// -- index parsing -----------------------------------------------------------

test('registry entries are validated: https-only tarballs, real sha256, sane names', () => {
  assert.throws(
    () => parseRegistryEntry({ ...entryFor(GOOD_TGZ), tarball: 'http://example.test/x.tgz' }),
    /https/,
  );
  assert.throws(() => parseRegistryEntry({ ...entryFor(GOOD_TGZ), sha256: 'abc' }), /sha256/);
  assert.throws(() => parseRegistryEntry({ ...entryFor(GOOD_TGZ), name: '../evil' }), /name/);
  assert.equal(parseRegistryIndex([entryFor(GOOD_TGZ)]).length, 1);
  assert.equal(parseRegistryIndex({ modules: [entryFor(GOOD_TGZ)] }).length, 1);
});

// -- download + verify --------------------------------------------------------

test('a tampered tarball fails the sha256 pin before anything is unpacked', async () => {
  const entry = entryFor(GOOD_TGZ);
  const tampered = Buffer.concat([GOOD_TGZ, Buffer.from([0x00])]);
  await assert.rejects(
    downloadAndVerify(entry, { fetchImpl: fakeFetch({ [entry.tarball]: tampered }) }),
    /sha256 mismatch/,
  );
});

test('a tarball over the size cap is refused', async () => {
  const entry = entryFor(GOOD_TGZ);
  await assert.rejects(
    downloadAndVerify(entry, {
      fetchImpl: fakeFetch({ [entry.tarball]: GOOD_TGZ }),
      maxBytes: 10,
    }),
    /cap/,
  );
});

// -- strict extraction ---------------------------------------------------------

test('zip-slip entries are a hard error, not a skipped file', () => {
  const dir = tmp();
  try {
    for (const evil of ['../evil.js', '/abs.js', 'ok/../../evil.js', 'C:/win.js']) {
      assert.throws(
        () => extractTarGz(buildTgz([{ name: evil, content: 'x' }]), join(dir, 'out')),
        InstallError,
        `should refuse ${evil}`,
      );
    }
    assert.equal(existsSync(join(dir, 'evil.js')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('symlink and hardlink entries are refused outright', () => {
  const dir = tmp();
  try {
    for (const type of ['1', '2', '3', '6']) {
      assert.throws(
        () => extractTarGz(buildTgz([{ name: 'link', content: null, type }]), join(dir, 'out')),
        /not allowed/,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a clean archive extracts files and directories faithfully', () => {
  const dir = tmp();
  try {
    const written = extractTarGz(
      buildTgz([
        { name: 'sub', content: null, type: '5' },
        { name: 'sub/a.txt', content: 'hello' },
        { name: 'manifest.json', content: '{}' },
      ]),
      join(dir, 'out'),
    );
    assert.deepEqual(written.sort(), ['manifest.json', 'sub/a.txt']);
    assert.equal(readFileSync(join(dir, 'out', 'sub', 'a.txt'), 'utf8'), 'hello');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- stage + commit -------------------------------------------------------------

test('stage → commit lands the module under its registry name', async () => {
  const dir = tmp();
  try {
    const entry = entryFor(GOOD_TGZ);
    const staged = await stageModule(entry, {
      stagingRoot: join(dir, 'staging'),
      hostVersion: '1.0.0',
      fetchImpl: fakeFetch({ [entry.tarball]: GOOD_TGZ }),
    });
    assert.equal(staged.name, 'demo-mod');
    const dest = commitModule(staged, join(dir, 'modules'));
    assert.equal(existsSync(join(dest, 'manifest.json')), true);
    assert.equal(existsSync(join(dest, 'tools.js')), true);
    assert.equal(existsSync(staged.dir), false, 'staging is cleaned up after commit');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a manifest claiming a different name than the index entry is refused', async () => {
  const dir = tmp();
  try {
    const liar = buildTgz([
      // Index says demo-mod; the payload claims to be the (installed) websearch
      // module. Committing it would overwrite a module the user trusts.
      { name: 'manifest.json', content: '{"name":"modulus-websearch","version":"9.9.9"}' },
    ]);
    const entry = entryFor(liar);
    await assert.rejects(
      stageModule(entry, {
        stagingRoot: join(dir, 'staging'),
        hostVersion: '1.0.0',
        fetchImpl: fakeFetch({ [entry.tarball]: liar }),
      }),
      /does not match registry entry/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fresh install refuses to overwrite; replace is the explicit update path', async () => {
  const dir = tmp();
  try {
    const entry = entryFor(GOOD_TGZ);
    const fetchImpl = fakeFetch({ [entry.tarball]: GOOD_TGZ });
    const opts = { stagingRoot: join(dir, 'staging'), hostVersion: '1.0.0', fetchImpl };
    commitModule(await stageModule(entry, opts), join(dir, 'modules'));
    await assert.rejects(
      (async () => commitModule(await stageModule(entry, opts), join(dir, 'modules')))(),
      /already installed/,
    );
    const dest = commitModule(await stageModule(entry, opts), join(dir, 'modules'), {
      replace: true,
    });
    assert.equal(existsSync(join(dest, 'manifest.json')), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('minCoreVersion newer than the host blocks the install with a clear message', async () => {
  const dir = tmp();
  try {
    const entry = entryFor(GOOD_TGZ, { minCoreVersion: '2.5.0' });
    await assert.rejects(
      stageModule(entry, {
        stagingRoot: join(dir, 'staging'),
        hostVersion: '1.0.0',
        fetchImpl: fakeFetch({ [entry.tarball]: GOOD_TGZ }),
      }),
      /needs Modulus >= 2\.5\.0/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- consent -----------------------------------------------------------------

test('permissionDiff surfaces only ADDED capabilities (re-consent trigger)', () => {
  const before = { network: ['duckduckgo.com'], subprocess: ['ffmpeg'] };
  assert.deepEqual(permissionDiff(before, before), {});
  assert.deepEqual(permissionDiff(before, { network: ['duckduckgo.com', 'tracker.evil'] }), {
    network: ['tracker.evil'],
  });
  // Dropping a permission needs no re-consent.
  assert.deepEqual(permissionDiff(before, { network: ['duckduckgo.com'] }), {});
});

test('consent lines are plain language, not jargon', () => {
  const lines = describePermissions({ network: ['duckduckgo.com'], subprocess: ['ffmpeg'] });
  // "Declares …" framing: these describe what the manifest claims, not granted access.
  assert.ok(lines.every((l) => l.startsWith('Declares ')));
  assert.ok(lines.some((l) => l.includes('contacts duckduckgo.com')));
  assert.ok(lines.some((l) => l.includes('runs the program "ffmpeg"')));
  assert.deepEqual(describePermissions({}), ['Needs no special permissions']);
});

test('network "*" wildcard reads as "any site", not a literal star', () => {
  const lines = describePermissions({ network: ['*'] });
  assert.deepEqual(lines, ['Declares it contacts any site on the internet']);
});
