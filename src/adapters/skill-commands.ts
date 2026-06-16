// Pure command logic for the Telegram skill surface: /skills (list what's
// available) and /skill <name> (view one skill's playbook + the tools it would
// use). Skills are reference guidance the assistant loads on its own when a
// request matches — these commands are discovery only; there is nothing to
// "run" here, and no command can grant a tool. A skill's capability is exactly
// the consented tools, shown per-tool in everyday language so the surface tells
// the same truth as the install consent screen.

import type { ToolRegistry } from '../core/tools.js';
import type { SkillRecord } from '../core/skills.js';
import { describeSkillTools, type SkillToolTier } from '../core/installer.js';

// Minimal read view of the skill loader — keeps the adapter decoupled from the
// loader's lifecycle surface (and trivial to fake in tests).
export interface SkillView {
  list(): SkillRecord[];
  get(name: string): SkillRecord | undefined;
}

export interface SkillDeps {
  skills: SkillView;
  tools: ToolRegistry;
}

// How long a Telegram message can comfortably carry a playbook excerpt before
// it gets unwieldy. The full text always reaches the model on use_skill; this
// is just a human preview.
const PLAYBOOK_PREVIEW_CHARS = 1500;

function resolveTiers(deps: SkillDeps, allowlist: readonly string[]): Array<{ name: string; tier: SkillToolTier }> {
  return allowlist.map((name) => {
    const handler = deps.tools.get(name);
    return { name, tier: (handler ? handler.tier : 'unknown') as SkillToolTier };
  });
}

// /skills — the available reference playbooks, usable ones first.
export function handleSkills(deps: SkillDeps): string {
  const all = deps.skills.list();
  const usable = all.filter((s) => s.enabled && !s.error);
  if (usable.length === 0) {
    const blocked = all.filter((s) => !s.enabled || s.error);
    if (blocked.length === 0) {
      return 'No skills installed yet. Add one from the Modules tab (Skills section) in the panel.';
    }
    // Everything present is disabled/errored — say so rather than "none".
    const lines = blocked.map((s) => `- ${s.name}${s.error ? ` — unavailable (${s.error})` : ' — disabled'}`);
    return ['🧩 Skills (none active):', ...lines].join('\n');
  }
  const lines = usable.map((s) => `- ${s.name} — ${s.summary}`);
  const out = ['🧩 Skills the assistant can draw on:', ...lines, '', 'View one with /skill <name>.'];
  const blocked = all.filter((s) => !s.enabled || s.error);
  if (blocked.length > 0) {
    out.push('', `Also installed but inactive: ${blocked.map((s) => s.name).join(', ')}.`);
  }
  return out.join('\n');
}

// /skill <name> — one skill's summary, the tools it would use (with tiers), and
// a preview of the playbook the model loads on demand.
export function handleSkill(deps: SkillDeps, arg: string): string {
  const name = arg.trim().toLowerCase();
  if (!name) return 'Usage: /skill <name> — run /skills to see them.';
  const rec = deps.skills.get(name);
  if (!rec) return `No skill named '${name}'. Run /skills to see them.`;
  if (rec.error) return `Skill '${name}' is installed but unavailable: ${rec.error}`;

  const header = rec.enabled ? `🧩 ${rec.name} (v${rec.version})` : `🧩 ${rec.name} (v${rec.version}) — disabled`;
  const toolLines = describeSkillTools(resolveTiers(deps, rec.toolAllowlist));

  const out = [header, '', rec.summary, '', 'Tools:', ...toolLines.map((l) => `· ${l}`)];

  if (rec.enabled && rec.instructions) {
    let preview = rec.instructions.trim();
    if (preview.length > PLAYBOOK_PREVIEW_CHARS) {
      preview = `${preview.slice(0, PLAYBOOK_PREVIEW_CHARS).trimEnd()}\n…`;
    }
    out.push('', 'Playbook (the assistant loads this automatically when it fits):', '', preview);
  }
  return out.join('\n');
}
