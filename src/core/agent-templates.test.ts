import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../storage/db.js';
import { createAgentRegistry } from './agents.js';
import {
  AGENT_TEMPLATES,
  AGENT_TEMPLATE_NAME_RE,
  getTemplate,
  hireFromTemplate,
} from './agent-templates.js';

const PROFILES = new Set(['chat', 'tools', 'reason']);

test('every template builds a valid, creatable CreateAgentInput', () => {
  const dir = mkdtempSync(join(tmpdir(), 'modulus-tmpl-'));
  try {
    const db = open({ path: join(dir, 'g.db') });
    const reg = createAgentRegistry(db);
    assert.ok(AGENT_TEMPLATES.length >= 6, 'catalog has the curated presets');

    const ids = new Set<string>();
    for (const tmpl of AGENT_TEMPLATES) {
      assert.ok(tmpl.id && !ids.has(tmpl.id), `template id ${tmpl.id} is present and unique`);
      ids.add(tmpl.id);
      assert.ok(tmpl.title && tmpl.description && tmpl.icon, `${tmpl.id} has card fields`);

      const input = tmpl.build();
      assert.match(input.name, AGENT_TEMPLATE_NAME_RE, `${tmpl.id} name is a valid agent name`);
      assert.ok(input.systemPrompt.trim().length > 0, `${tmpl.id} has a non-empty prompt`);
      assert.ok(PROFILES.has(input.profile ?? 'chat'), `${tmpl.id} profile is valid`);
      assert.ok(Array.isArray(input.toolAllowlist), `${tmpl.id} toolAllowlist is module names`);

      // It actually persists through the real registry (origin defaults to null
      // — a user-owned agent, not a module agent).
      const agent = reg.create(input);
      assert.equal(agent.origin, null);
      assert.equal(agent.name, input.name);
    }
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('coder-local is an autonomous, local-model coder (no codex handoff)', () => {
  const input = getTemplate('coder-local')!.build();
  assert.equal(input.mode, 'autonomous'); // gets the plan/save_artifact loop
  assert.equal(input.profile, 'reason'); // runs on the local heavy model
  assert.deepEqual(input.toolAllowlist, ['read_file', 'list_dir']); // reads the project; no modulus-codex
  assert.ok(!input.toolAllowlist!.includes('modulus-codex'));
  assert.match(input.systemPrompt, /save_artifact/); // delivers code as artifacts
});

test('getTemplate resolves by id and misses cleanly', () => {
  assert.equal(getTemplate('researcher')?.title, 'Researcher');
  assert.equal(getTemplate('does-not-exist'), undefined);
});

test('hireFromTemplate honors a name override and falls back to the default', () => {
  const tmpl = getTemplate('researcher')!;
  assert.equal(hireFromTemplate(tmpl).name, 'researcher'); // default suggested name
  assert.equal(hireFromTemplate(tmpl, 'newsbot').name, 'newsbot'); // override applied
  assert.equal(hireFromTemplate(tmpl, '   ').name, 'researcher'); // blank → default
  // The override only changes the name; the rest of the persona is intact.
  assert.equal(hireFromTemplate(tmpl, 'newsbot').profile, 'tools');
  assert.deepEqual(hireFromTemplate(tmpl, 'newsbot').toolAllowlist, ['modulus-websearch']);
});
