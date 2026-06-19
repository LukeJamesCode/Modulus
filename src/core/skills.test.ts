// Skill loader tests. The loader is the pure-data sibling of the module loader;
// the behaviour that matters:
// - a valid skill folder loads into a SkillRecord (summary, playbook text,
//   tool allowlist, compiled intent pattern)
// - skill `agents` sync into the fleet with origin 'skill:<name>', upserted on
//   reload (id preserved), swept on uninstall — the module-agent contract,
//   reused
// - the CODE-FREE guarantee holds at LOAD time too: a folder carrying an
//   executable file is refused (and, by construction, nothing is ever imported)
// - a disabled skill (skill_state.enabled = 0) is skipped and its personas drop

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { open } from '../storage/db.js';
import { createLogger } from '../util/log.js';
import { createToolRegistry } from './tools.js';
import { createAgentRegistry } from './agents.js';
import { createSkillLoader, type SkillLoaderOptions } from './skills.js';

const log = createLogger({ level: 'error', out: () => {}, err: () => {} });

function writeSkill(
  root: string,
  name: string,
  manifest: Record<string, unknown>,
  files: Record<string, string> = { 'SKILL.md': '# Playbook\n\nGuidance.' },
): string {
  const folder = join(root, name);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'skill.json'), JSON.stringify(manifest, null, 2));
  for (const [rel, content] of Object.entries(files)) {
    const p = join(folder, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, content);
  }
  return folder;
}

function harness(): {
  root: string;
  db: ReturnType<typeof open>;
  agents: ReturnType<typeof createAgentRegistry>;
  makeLoader: () => ReturnType<typeof createSkillLoader>;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'modulus-skills-'));
  const root = join(dir, 'skills');
  mkdirSync(root, { recursive: true });
  const db = open({ path: join(dir, 'g.db'), log });
  const agents = createAgentRegistry(db);
  const makeLoader = () => {
    const opts: SkillLoaderOptions = {
      roots: [root],
      db,
      log,
      hostVersion: '1.5.0',
      tools: createToolRegistry({ log }),
      agents,
      watch: false,
    };
    return createSkillLoader(opts);
  };
  return {
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

const TRIP_PLANNER = {
  kind: 'skill',
  name: 'trip-planner',
  version: '1.0.0',
  modulus: '*',
  summary: 'Plan multi-stop travel',
  instructions: 'SKILL.md',
  tools: ['web_search', 'add_event'],
  intent_pattern: 'trip|travel|itinerary',
};

test('a valid skill folder loads into a SkillRecord', async () => {
  const h = harness();
  try {
    writeSkill(h.root, 'trip-planner', TRIP_PLANNER, {
      'SKILL.md': '# Trip planner\n\nStep one.',
    });
    const loader = h.makeLoader();
    await loader.loadAll();
    const rec = loader.get('trip-planner');
    assert.ok(rec, 'skill should be loaded');
    assert.equal(rec.enabled, true);
    assert.equal(rec.summary, 'Plan multi-stop travel');
    assert.match(rec.instructions, /Trip planner/);
    assert.deepEqual(rec.toolAllowlist, ['web_search', 'add_event']);
    assert.ok(rec.intentPattern instanceof RegExp);
    assert.ok(rec.intentPattern!.test('book a TRIP'));
    assert.equal(rec.error, undefined);
  } finally {
    h.cleanup();
  }
});

test('skill agents sync into the fleet with origin skill:<name> and upsert on reload', async () => {
  const h = harness();
  try {
    writeSkill(h.root, 'trip-planner', {
      ...TRIP_PLANNER,
      agents: [
        {
          name: 'concierge',
          role: 'Trip concierge',
          systemPrompt: 'You plan trips.',
          profile: 'tools',
        },
      ],
    });
    const loader = h.makeLoader();
    await loader.loadAll();
    const agent = h.agents.getByName('concierge');
    assert.ok(agent, 'persona should be registered');
    assert.equal(agent.origin, 'skill:trip-planner');
    // Default tool scope = the skill's consented tools.
    const full = h.agents.get(agent.id);
    assert.deepEqual(full?.toolAllowlist, ['web_search', 'add_event']);

    // Reload must preserve the agent id (task history hangs off it).
    const idBefore = agent.id;
    await loader.reload('trip-planner');
    assert.equal(h.agents.getByName('concierge')?.id, idBefore);

    assert.deepEqual(loader.get('trip-planner')?.registeredAgents, ['concierge']);
  } finally {
    h.cleanup();
  }
});

test('a skill carrying executable content is refused at load time', async () => {
  const h = harness();
  try {
    // The loader path never imports anything, so even if this file existed it
    // could not run; the load-time gate refuses the whole skill regardless.
    writeSkill(h.root, 'trip-planner', TRIP_PLANNER, {
      'SKILL.md': '# x',
      'evil.js': 'globalThis.__SKILL_RAN__ = true;',
    });
    const loader = h.makeLoader();
    await loader.loadAll();
    const rec = loader.get('trip-planner');
    assert.ok(rec, 'skill should be recorded');
    assert.equal(rec.enabled, true);
    assert.match(rec.error ?? '', /non-data file: evil\.js/);
    // Nothing from the bundle executed.
    assert.equal((globalThis as Record<string, unknown>)['__SKILL_RAN__'], undefined);
    // A failed-validation skill grants no tools.
    assert.deepEqual(rec.toolAllowlist, []);
  } finally {
    h.cleanup();
  }
});

test('a disabled skill is skipped and its personas are removed', async () => {
  const h = harness();
  try {
    writeSkill(h.root, 'trip-planner', {
      ...TRIP_PLANNER,
      agents: [{ name: 'concierge', systemPrompt: 'You plan trips.' }],
    });
    const loader = h.makeLoader();
    await loader.loadAll();
    assert.ok(h.agents.getByName('concierge'), 'persona present while enabled');

    // Disable it the way the panel/Telegram flow will, then reload.
    h.db.prepare(`UPDATE skill_state SET enabled = 0 WHERE name = ?`).run('trip-planner');
    await loader.reload('trip-planner');

    const rec = loader.get('trip-planner');
    assert.equal(rec?.enabled, false);
    assert.equal(rec?.instructions, '');
    assert.equal(h.agents.getByName('concierge'), undefined, 'persona dropped when disabled');
  } finally {
    h.cleanup();
  }
});

test('the shipped first-party launch skills all load cleanly', async () => {
  const repoSkills = resolve(fileURLToPath(import.meta.url), '..', '..', '..', 'skills');
  if (!existsSync(repoSkills)) return; // packaged build without sources
  const dir = mkdtempSync(join(tmpdir(), 'modulus-launch-'));
  const db = open({ path: join(dir, 'g.db'), log });
  try {
    const loader = createSkillLoader({
      roots: [repoSkills],
      db,
      log,
      hostVersion: '1.5.0',
      tools: createToolRegistry({ log }),
      agents: createAgentRegistry(db),
      watch: false,
    });
    await loader.loadAll();
    const names = loader
      .list()
      .map((s) => s.name)
      .sort();
    // At least the three reference skills, each enabled and error-free.
    for (const expected of ['day-planner', 'meeting-prep', 'trip-planner']) {
      assert.ok(names.includes(expected), `missing launch skill: ${expected}`);
      const rec = loader.get(expected)!;
      assert.equal(rec.enabled, true);
      assert.equal(rec.error, undefined, `${expected} failed to load: ${rec.error}`);
      assert.ok(rec.instructions.length > 0);
      assert.ok(rec.toolAllowlist.length > 0);
    }
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a skill requiring a newer Modulus is recorded as an error, not loaded', async () => {
  const h = harness();
  try {
    writeSkill(h.root, 'trip-planner', { ...TRIP_PLANNER, modulus: '>=9.0.0' });
    const loader = h.makeLoader();
    await loader.loadAll();
    const rec = loader.get('trip-planner');
    assert.match(rec?.error ?? '', /needs Modulus/);
  } finally {
    h.cleanup();
  }
});
