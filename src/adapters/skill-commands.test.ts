import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import type { ToolRegistry, ToolHandler } from '../core/tools.js';
import type { SkillRecord } from '../core/skills.js';
import { handleSkills, handleSkill, type SkillDeps, type SkillView } from './skill-commands.js';

// A skill record with sensible defaults; override what a case cares about.
function rec(p: Partial<SkillRecord> & { name: string }): SkillRecord {
  return {
    version: '1.0.0',
    enabled: true,
    summary: `${p.name} summary`,
    instructions: '',
    toolAllowlist: [],
    registeredAgents: [],
    loadedAt: 0,
    ...p,
  };
}

// Minimal ToolRegistry stub — the adapter only reads .get(name).tier.
function tools(tiers: Record<string, ToolHandler['tier']>): ToolRegistry {
  return {
    get: (name: string) =>
      name in tiers ? ({ name, tier: tiers[name] } as ToolHandler) : undefined,
  } as unknown as ToolRegistry;
}

function deps(records: SkillRecord[], tiers: Record<string, ToolHandler['tier']> = {}): SkillDeps {
  const view: SkillView = {
    list: () => records,
    get: (name) => records.find((r) => r.name === name),
  };
  return { skills: view, tools: tools(tiers) };
}

test('/skills lists usable skills and notes inactive ones', () => {
  const d = deps([
    rec({ name: 'trip-planner' }),
    rec({ name: 'meeting-prep', enabled: false }),
    rec({ name: 'broken', error: 'missing playbook (SKILL.md)' }),
  ]);
  const out = handleSkills(d);
  assert.match(out, /trip-planner — trip-planner summary/);
  assert.match(out, /Also installed but inactive: meeting-prep, broken/);
  // The active list must not surface a disabled/errored skill as drawable.
  assert.doesNotMatch(out.split('Also installed')[0]!, /meeting-prep/);
});

test('/skills with nothing installed points to the panel', () => {
  assert.match(handleSkills(deps([])), /No skills installed yet/);
});

test('/skill <name> shows tools in everyday language by tier', () => {
  const d = deps(
    [rec({ name: 'trip-planner', toolAllowlist: ['web_search', 'add_event', 'ghost_tool'] })],
    { web_search: 'auto', add_event: 'confirm' },
  );
  const out = handleSkill(d, 'trip-planner');
  assert.match(out, /Uses web_search \(runs automatically\)/);
  assert.match(out, /Uses add_event \(asks you each time\)/);
  // A tool the skill names but that isn't installed stays unavailable.
  assert.match(out, /Wants ghost_tool \(not installed/);
});

test('/skill previews the playbook and truncates a long one', () => {
  const long = 'A'.repeat(5000);
  const d = deps([rec({ name: 'trip-planner', instructions: long })]);
  const out = handleSkill(d, 'trip-planner');
  assert.match(out, /Playbook \(the assistant loads this/);
  assert.match(out, /…$/);
  assert.ok(out.length < long.length, 'long playbook should be truncated');
});

test('/skill is case-insensitive and reports unknown / errored skills', () => {
  const d = deps([rec({ name: 'broken', error: 'needs Modulus >=2.0.0, host is 1.5.0' })]);
  assert.match(handleSkill(d, 'TRIP-planner'), /No skill named 'trip-planner'/);
  assert.match(handleSkill(d, 'broken'), /installed but unavailable: needs Modulus/);
  assert.match(handleSkill(d, '   '), /Usage: \/skill <name>/);
});
