import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { open, type DB } from '../../storage/db.js';
import { createLogger } from '../../util/log.js';
import { createSkillLoader } from '../../core/skills.js';
import { HOST_VERSION } from '../../core/version.js';
import type { FetchLike } from '../../core/installer.js';
import type { ToolRegistry, ToolHandler } from '../../core/tools.js';
import type { PanelDeps } from '../types.js';
import {
  browseSkillRegistry,
  installSkillFromRegistry,
  listInstalledSkills,
  setSkillEnabled,
  uninstallSkill,
} from './skills.js';

const log = createLogger({ level: 'error', out: () => {}, err: () => {} });

// -- minimal ustar tar builder (mirrors marketplace.test.ts) ----------------
function tarHeader(name: string, size: number): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write('0', 156);
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
  return Buffer.concat([tarHeader(name, data.length), padded]);
}
function buildSkillTgz(
  name: string,
  version: string,
  o: { tools?: string[]; withCode?: boolean } = {},
): Buffer {
  const manifest = JSON.stringify({
    kind: 'skill',
    name,
    version,
    modulus: '*',
    summary: `${name} does a thing`,
    ...(o.tools ? { tools: o.tools } : {}),
  });
  const parts = [
    tarEntry('skill.json', manifest),
    tarEntry('SKILL.md', `# ${name}\n\nStep one. Step two.`),
  ];
  if (o.withCode) parts.push(tarEntry('evil.js', 'export function register() {}'));
  return gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
}
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

const INDEX_URL = 'https://reg.test/index.json';

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
const indexJson = (entries: unknown[]): Buffer => Buffer.from(JSON.stringify(entries), 'utf8');

// Fake tool registry: only tiers matter for the consent lines.
function tools(tiers: Record<string, ToolHandler['tier']>): ToolRegistry {
  return {
    get: (name: string) => (name in tiers ? ({ name, tier: tiers[name] } as ToolHandler) : undefined),
    list: () => [],
  } as unknown as ToolRegistry;
}

interface Harness {
  deps: PanelDeps;
  home: string;
  cleanup: () => Promise<void>;
}

async function harness(): Promise<Harness> {
  const home = mkdtempSync(join(tmpdir(), 'modulus-skill-route-'));
  const db: DB = open({ path: join(home, 'modulus.db'), log });
  const toolReg = tools({ web_search: 'auto', add_event: 'confirm' });
  const loader = createSkillLoader({
    roots: [join(home, 'skills')],
    db,
    log,
    hostVersion: HOST_VERSION,
    tools: toolReg,
    watch: false,
  });
  await loader.loadAll();
  const deps = {
    db,
    log,
    home,
    skills: { loader, tools: toolReg },
  } as unknown as PanelDeps;
  return {
    deps,
    home,
    cleanup: async () => {
      await loader.shutdown();
      db.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test('browse lists only kind:skill entries with per-tool consent lines', async () => {
  const h = await harness();
  try {
    const tgz = buildSkillTgz('trip-planner', '1.0.0', { tools: ['web_search', 'add_event'] });
    const tarball = 'https://reg.test/trip-planner.tgz';
    const skill = {
      name: 'trip-planner',
      kind: 'skill',
      version: '1.0.0',
      tarball,
      sha256: sha(tgz),
      tools: ['web_search', 'add_event'],
    };
    const mod = { name: 'modulus-demo', version: '1.0.0', tarball: 'https://reg.test/m.tgz', sha256: sha(tgz) };
    const opts = { fetchImpl: fakeFetch({ [INDEX_URL]: indexJson([skill, mod]) }), registryUrl: INDEX_URL };

    const r = await browseSkillRegistry(h.deps, opts);
    assert.equal(r.skills.length, 1, 'the module entry is filtered out');
    assert.equal(r.skills[0]!.name, 'trip-planner');
    assert.deepEqual(r.skills[0]!.tools, [
      'Uses web_search (runs automatically)',
      'Uses add_event (asks you each time)',
    ]);
    assert.equal(r.skills[0]!.installed, false);
  } finally {
    await h.cleanup();
  }
});

test('install is blocked until tool consent (409), then loads the skill', async () => {
  const h = await harness();
  try {
    const tgz = buildSkillTgz('trip-planner', '1.0.0', { tools: ['web_search', 'add_event'] });
    const tarball = 'https://reg.test/trip-planner.tgz';
    const entry = {
      name: 'trip-planner',
      kind: 'skill',
      version: '1.0.0',
      tarball,
      sha256: sha(tgz),
      tools: ['web_search', 'add_event'],
    };
    const opts = {
      fetchImpl: fakeFetch({ [INDEX_URL]: indexJson([entry]), [tarball]: tgz }),
      registryUrl: INDEX_URL,
    };

    const blocked = await installSkillFromRegistry(h.deps, { name: 'trip-planner' }, opts);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body['needsConsent'], true);
    assert.deepEqual(blocked.body['added'], [
      'Uses web_search (runs automatically)',
      'Uses add_event (asks you each time)',
    ]);
    // Nothing on disk, nothing loaded while consent is pending.
    assert.equal(existsSync(join(h.home, 'skills', 'trip-planner')), false);
    assert.equal(listInstalledSkills(h.deps).length, 0);

    const ok = await installSkillFromRegistry(h.deps, { name: 'trip-planner', acceptAdded: true }, opts);
    assert.equal(ok.status, 200);
    const installed = listInstalledSkills(h.deps);
    assert.equal(installed.length, 1);
    assert.equal(installed[0]!.name, 'trip-planner');
    assert.equal(installed[0]!.enabled, true);
    assert.match(installed[0]!.playbook, /Step one/);
  } finally {
    await h.cleanup();
  }
});

test('a skill bundle carrying code is refused by the code-free gate (400)', async () => {
  const h = await harness();
  try {
    const tgz = buildSkillTgz('sneaky', '1.0.0', { tools: [], withCode: true });
    const tarball = 'https://reg.test/sneaky.tgz';
    const entry = { name: 'sneaky', kind: 'skill', version: '1.0.0', tarball, sha256: sha(tgz) };
    const opts = {
      fetchImpl: fakeFetch({ [INDEX_URL]: indexJson([entry]), [tarball]: tgz }),
      registryUrl: INDEX_URL,
    };
    // No tools → no consent gate, so install proceeds straight to staging where
    // assertNoExecutableContent rejects the .js.
    const r = await installSkillFromRegistry(h.deps, { name: 'sneaky', acceptAdded: true }, opts);
    assert.equal(r.status, 400);
    assert.match(String(r.body['error']), /non-data file/);
    assert.equal(existsSync(join(h.home, 'skills', 'sneaky')), false);
  } finally {
    await h.cleanup();
  }
});

test('enable/disable flips skill_state and the loader reflects it', async () => {
  const h = await harness();
  try {
    const tgz = buildSkillTgz('trip-planner', '1.0.0', { tools: [] });
    const tarball = 'https://reg.test/trip-planner.tgz';
    const entry = { name: 'trip-planner', kind: 'skill', version: '1.0.0', tarball, sha256: sha(tgz) };
    const opts = {
      fetchImpl: fakeFetch({ [INDEX_URL]: indexJson([entry]), [tarball]: tgz }),
      registryUrl: INDEX_URL,
    };
    await installSkillFromRegistry(h.deps, { name: 'trip-planner', acceptAdded: true }, opts);

    assert.equal(await setSkillEnabled(h.deps, 'trip-planner', false), true);
    let rec = listInstalledSkills(h.deps)[0]!;
    assert.equal(rec.enabled, false);
    assert.equal(rec.playbook, '', 'a disabled skill exposes no playbook');

    assert.equal(await setSkillEnabled(h.deps, 'trip-planner', true), true);
    rec = listInstalledSkills(h.deps)[0]!;
    assert.equal(rec.enabled, true);
    assert.match(rec.playbook, /Step one/);

    // Unknown skill toggles are a 404 (false), not a silent success.
    assert.equal(await setSkillEnabled(h.deps, 'ghost', true), false);
  } finally {
    await h.cleanup();
  }
});

test('uninstall removes the bundle, drops state, and unloads', async () => {
  const h = await harness();
  try {
    const tgz = buildSkillTgz('trip-planner', '1.0.0', { tools: [] });
    const tarball = 'https://reg.test/trip-planner.tgz';
    const entry = { name: 'trip-planner', kind: 'skill', version: '1.0.0', tarball, sha256: sha(tgz) };
    const opts = {
      fetchImpl: fakeFetch({ [INDEX_URL]: indexJson([entry]), [tarball]: tgz }),
      registryUrl: INDEX_URL,
    };
    await installSkillFromRegistry(h.deps, { name: 'trip-planner', acceptAdded: true }, opts);
    assert.equal(listInstalledSkills(h.deps).length, 1);

    const r = await uninstallSkill(h.deps, 'trip-planner');
    assert.equal(r.status, 200);
    assert.equal(existsSync(join(h.home, 'skills', 'trip-planner')), false);
    assert.equal(listInstalledSkills(h.deps).length, 0);
    const row = h.deps.db.prepare(`SELECT * FROM skill_state WHERE name = ?`).get('trip-planner');
    assert.equal(row, undefined);

    // A skill the host doesn't have under the user root is a 404 (never touches
    // the repo's first-party skills dir).
    assert.equal((await uninstallSkill(h.deps, 'not-there')).status, 404);
  } finally {
    await h.cleanup();
  }
});
