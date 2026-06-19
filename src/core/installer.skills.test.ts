// Skill installer tests. A skill is the SAFE tier of the marketplace: pure
// prompt data, no code. Each test encodes a refusal that keeps that promise
// verifiable for a non-technical user clicking "Install":
// - kind is parsed and defaults to 'module' (every pre-skills index stays valid)
// - a tampered skill tarball (sha mismatch) is never unpacked
// - a skill bundle carrying CODE (any executable file, node_modules/,
//   migrations/, or an `entrypoints` key) is refused — the code-free boundary
// - identity, playbook presence, size cap, and tool-allowlist parsing hold
// - capability growth on update is detectable (skillToolDiff) for re-consent

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseRegistryEntry,
  stageSkill,
  commitSkill,
  skillToolDiff,
  describeSkillTools,
  assertNoExecutableContent,
  extractTarGz,
  InstallError,
  MAX_SKILL_INSTRUCTIONS_BYTES,
  type FetchLike,
  type RegistryIndexEntry,
} from './installer.js';

// -- minimal tar builder (test-only) ----------------------------------------

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

function tarEntry(name: string, content: string | null, type = '0'): Buffer {
  const data = content === null ? Buffer.alloc(0) : Buffer.from(content, 'utf8');
  const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
  data.copy(padded);
  return Buffer.concat([tarHeader(name, data.length, type), padded]);
}

function buildTgz(entries: Array<{ name: string; content: string | null; type?: string }>): Buffer {
  const parts = entries.map((e) => tarEntry(e.name, e.content, e.type ?? '0'));
  parts.push(Buffer.alloc(1024));
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

const TARBALL = 'https://example.test/trip-planner-1.0.0.tgz';

function skillManifest(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    kind: 'skill',
    name: 'trip-planner',
    version: '1.0.0',
    modulus: '*',
    summary: 'Plan multi-stop travel',
    instructions: 'SKILL.md',
    tools: ['web_search', 'add_event'],
    ...over,
  });
}

const GOOD_SKILL = [
  { name: 'skill.json', content: skillManifest() },
  { name: 'SKILL.md', content: '# Trip planner\n\nGuidance goes here.' },
  { name: 'references/cities.md', content: '# Cities' },
  { name: 'icon.svg', content: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' },
  { name: 'LICENSE', content: 'MIT' },
];

function entryFor(tgz: Buffer, over: Partial<RegistryIndexEntry> = {}): RegistryIndexEntry {
  return {
    name: 'trip-planner',
    kind: 'skill',
    version: '1.0.0',
    tarball: TARBALL,
    sha256: sha(tgz),
    ...over,
  };
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'modulus-skill-'));
}

async function stage(tgz: Buffer, over: Partial<RegistryIndexEntry> = {}) {
  const stagingRoot = tmp();
  try {
    return await stageSkill(entryFor(tgz, over), {
      stagingRoot,
      hostVersion: '1.5.0',
      fetchImpl: fakeFetch({ [TARBALL]: tgz }),
    });
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}

// -- kind parsing ------------------------------------------------------------

test('registry kind defaults to module and accepts skill; anything else is refused', () => {
  const base = {
    name: 'trip-planner',
    version: '1.0.0',
    tarball: TARBALL,
    sha256: 'a'.repeat(64),
  };
  assert.equal(parseRegistryEntry(base).kind, 'module');
  assert.equal(parseRegistryEntry({ ...base, kind: 'skill' }).kind, 'skill');
  assert.equal(parseRegistryEntry({ ...base, kind: 'module' }).kind, 'module');
  assert.throws(() => parseRegistryEntry({ ...base, kind: 'plugin' }), /bad kind/);
});

// -- the code-free boundary --------------------------------------------------

test('a clean skill bundle passes the code-free gate and stages', async () => {
  // Manage the staging root locally: staged.dir lives INSIDE it, so assertions
  // about the staged contents must run before the root is torn down.
  const stagingRoot = tmp();
  try {
    const staged = await stageSkill(entryFor(buildTgz(GOOD_SKILL)), {
      stagingRoot,
      hostVersion: '1.5.0',
      fetchImpl: fakeFetch({ [TARBALL]: buildTgz(GOOD_SKILL) }),
    });
    assert.equal(staged.name, 'trip-planner');
    assert.equal(staged.version, '1.0.0');
    assert.deepEqual(staged.tools, ['web_search', 'add_event']);
    assert.ok(existsSync(join(staged.dir, 'SKILL.md')));
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
});

test('a skill carrying an executable file is refused', async () => {
  const tgz = buildTgz([
    ...GOOD_SKILL,
    { name: 'tools.js', content: 'export function register(){}' },
  ]);
  await assert.rejects(() => stage(tgz), /non-data file: tools\.js/);
});

test('a skill carrying node_modules/ is refused', async () => {
  const tgz = buildTgz([...GOOD_SKILL, { name: 'node_modules/dep/index.js', content: 'x' }]);
  await assert.rejects(() => stage(tgz), /node_modules/);
});

test('a skill carrying migrations/ is refused', async () => {
  const tgz = buildTgz([...GOOD_SKILL, { name: 'migrations/0001_x.sql', content: 'SELECT 1;' }]);
  await assert.rejects(() => stage(tgz), /migrations/);
});

test('a skill declaring entrypoints is refused even with no code files', async () => {
  const tgz = buildTgz([
    { name: 'skill.json', content: skillManifest({ entrypoints: { tools: 'tools.js' } }) },
    { name: 'SKILL.md', content: '# x' },
  ]);
  await assert.rejects(() => stage(tgz), /entrypoints/);
});

test('assertNoExecutableContent passes inert data and throws on a stray script', () => {
  const ok = tmp();
  const bad = tmp();
  try {
    extractTarGz(buildTgz(GOOD_SKILL), ok);
    assert.doesNotThrow(() => assertNoExecutableContent(ok));
    extractTarGz(buildTgz([{ name: 'evil.sh', content: '#!/bin/sh\nrm -rf /' }]), bad);
    assert.throws(() => assertNoExecutableContent(bad), InstallError);
  } finally {
    rmSync(ok, { recursive: true, force: true });
    rmSync(bad, { recursive: true, force: true });
  }
});

// -- tamper + identity -------------------------------------------------------

test('a tampered skill tarball (sha mismatch) is never unpacked', async () => {
  const stagingRoot = tmp();
  try {
    await assert.rejects(
      () =>
        stageSkill(entryFor(buildTgz(GOOD_SKILL), { sha256: 'b'.repeat(64) }), {
          stagingRoot,
          hostVersion: '1.5.0',
          fetchImpl: fakeFetch({ [TARBALL]: buildTgz(GOOD_SKILL) }),
        }),
      /sha256 mismatch/,
    );
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
});

test('a skill.json claiming a different name than the index entry is refused', async () => {
  const tgz = buildTgz([
    { name: 'skill.json', content: skillManifest({ name: 'evil-twin' }) },
    { name: 'SKILL.md', content: '# x' },
  ]);
  await assert.rejects(() => stage(tgz), /does not match registry entry/);
});

test('a skill missing its playbook is refused', async () => {
  const tgz = buildTgz([{ name: 'skill.json', content: skillManifest() }]);
  await assert.rejects(() => stage(tgz), /missing its playbook/);
});

test('an oversized playbook is refused', async () => {
  const tgz = buildTgz([
    { name: 'skill.json', content: skillManifest() },
    { name: 'SKILL.md', content: 'x'.repeat(MAX_SKILL_INSTRUCTIONS_BYTES + 1) },
  ]);
  await assert.rejects(() => stage(tgz), /playbook exceeds/);
});

test('tools must be an array of strings', async () => {
  const tgz = buildTgz([
    { name: 'skill.json', content: skillManifest({ tools: 'web_search' }) },
    { name: 'SKILL.md', content: '# x' },
  ]);
  await assert.rejects(() => stage(tgz), /array of tool names/);
});

// -- commit ------------------------------------------------------------------

test('commitSkill installs into the skills root and refuses to clobber', async () => {
  const stagingRoot = tmp();
  const skillsRoot = tmp();
  try {
    const staged = await stageSkill(entryFor(buildTgz(GOOD_SKILL)), {
      stagingRoot,
      hostVersion: '1.5.0',
      fetchImpl: fakeFetch({ [TARBALL]: buildTgz(GOOD_SKILL) }),
    });
    const dest = commitSkill(staged, skillsRoot);
    assert.ok(existsSync(join(dest, 'SKILL.md')));

    // A second fresh install must refuse rather than overwrite.
    const staged2 = await stageSkill(entryFor(buildTgz(GOOD_SKILL)), {
      stagingRoot,
      hostVersion: '1.5.0',
      fetchImpl: fakeFetch({ [TARBALL]: buildTgz(GOOD_SKILL) }),
    });
    assert.throws(() => commitSkill(staged2, skillsRoot), /already installed/);
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
    rmSync(skillsRoot, { recursive: true, force: true });
  }
});

// -- consent helpers ---------------------------------------------------------

test('skillToolDiff reports only tools added on update', () => {
  assert.deepEqual(skillToolDiff(['web_search'], ['web_search', 'add_event']), ['add_event']);
  assert.deepEqual(skillToolDiff(['web_search', 'add_event'], ['web_search']), []);
  assert.deepEqual(skillToolDiff([], ['web_search']), ['web_search']);
});

test('describeSkillTools renders per-tool tiers in plain language', () => {
  const lines = describeSkillTools([
    { name: 'web_search', tier: 'auto' },
    { name: 'add_event', tier: 'confirm' },
    { name: 'wipe_disk', tier: 'owner' },
    { name: 'ghost', tier: 'unknown' },
  ]);
  assert.match(lines[0]!, /web_search \(runs automatically\)/);
  assert.match(lines[1]!, /add_event \(asks you each time\)/);
  assert.match(lines[2]!, /wipe_disk \(only you, the owner/);
  assert.match(lines[3]!, /ghost \(not installed/);
  assert.deepEqual(describeSkillTools([]), ['Uses no tools — this skill is guidance only']);
});
