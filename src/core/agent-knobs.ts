// Plain-language agent knobs — the single source of truth for the everyday
// vocabulary that hides the engine's field names (profile/thinkMode/mode/…).
// Shared by the Telegram CRUD commands (Phase 4 `/agent <name> set <knob>
// <value>`) and mirrored by the panel's Simple editor labels (agents.jsx), so
// both surfaces speak the same words.
//
// Pure + testable: applyKnob maps one plain knob+value onto an UpdateAgentInput
// patch (or returns an error string); describeAgentPlain renders an agent back
// into that vocabulary. No I/O, no registry — the caller owns reg.update.

import type { AgentDefinition, UpdateAgentInput } from './agents.js';
import type { ProfileName, ThinkMode } from './llm.js';

// brainpower: how capable a model the agent runs on. chat = the tiny model,
// reason = the heavy one. "balanced" maps to the tools profile (the middle
// tier in this project's profile set).
const BRAINPOWER_TO_PROFILE: Record<string, ProfileName> = {
  quick: 'chat',
  balanced: 'tools',
  deep: 'reason',
};
const PROFILE_TO_BRAINPOWER: Record<ProfileName, string> = {
  chat: 'quick',
  tools: 'balanced',
  reason: 'deep',
};

const THINK_VALUES: readonly ThinkMode[] = ['on', 'off', 'auto'];

// Parse the comma/space-separated list a `tools` knob takes. "all" clears the
// allowlist (null = every tool); "none" is the empty list (no tools).
function parseToolList(value: string): string[] | null {
  const v = value.trim().toLowerCase();
  if (v === 'all') return null;
  if (v === 'none' || v === '') return [];
  return value
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export type KnobResult = { patch: Partial<UpdateAgentInput> } | { error: string };

interface KnobDef {
  // The everyday "what does this control" line, used in usage/help text.
  describe: string;
  // Map a raw string value onto a patch, or explain why it's invalid.
  parse(value: string): KnobResult;
}

// The plain knob table. Keys are the everyday names the user types.
export const PLAIN_KNOBS: Record<string, KnobDef> = {
  brainpower: {
    describe: 'quick | balanced | deep — how capable a model it uses',
    parse(value) {
      const profile = BRAINPOWER_TO_PROFILE[value.trim().toLowerCase()];
      return profile
        ? { patch: { profile } }
        : { error: 'brainpower must be quick, balanced, or deep' };
    },
  },
  think: {
    describe: 'on | off | auto — whether it reasons before answering',
    parse(value) {
      const v = value.trim().toLowerCase() as ThinkMode;
      return THINK_VALUES.includes(v)
        ? { patch: { thinkMode: v } }
        : { error: 'think must be on, off, or auto' };
    },
  },
  solo: {
    describe: 'on | off — on = works a multi-step goal on its own (autonomous)',
    parse(value) {
      const v = value.trim().toLowerCase();
      if (v === 'on') return { patch: { mode: 'autonomous' } };
      if (v === 'off') return { patch: { mode: 'single' } };
      return { error: 'solo must be on or off' };
    },
  },
  delegate: {
    describe: 'on | off — whether it may hand work to other agents',
    parse(value) {
      const v = value.trim().toLowerCase();
      if (v === 'on') return { patch: { canDelegate: true } };
      if (v === 'off') return { patch: { canDelegate: false } };
      return { error: 'delegate must be on or off' };
    },
  },
  rounds: {
    describe: '1–12 — how many tool rounds it may take per turn',
    parse(value) {
      const n = Number.parseInt(value.trim(), 10);
      if (!Number.isInteger(n) || n < 1 || n > 12) {
        return { error: 'rounds must be a whole number from 1 to 12' };
      }
      return { patch: { maxToolRounds: n } };
    },
  },
  tools: {
    describe: 'all | none | a list — which tools/modules it may use',
    parse(value) {
      return { patch: { toolAllowlist: parseToolList(value) } };
    },
  },
};

export const PLAIN_KNOB_NAMES = Object.keys(PLAIN_KNOBS);

// Apply one plain knob onto an existing patch. Returns a new patch (the inputs
// are not mutated) or an error string the caller surfaces verbatim.
export function applyKnob(
  patch: Partial<UpdateAgentInput>,
  knob: string,
  value: string,
): KnobResult {
  const def = PLAIN_KNOBS[knob.trim().toLowerCase()];
  if (!def) {
    return { error: `Unknown setting '${knob}'. Try: ${PLAIN_KNOB_NAMES.join(', ')}.` };
  }
  const r = def.parse(value);
  if ('error' in r) return r;
  return { patch: { ...patch, ...r.patch } };
}

// Render an agent in the plain vocabulary — the body of Telegram's `/agent
// <name>` and the spirit of the panel's Simple view.
export function describeAgentPlain(agent: AgentDefinition): string {
  const brainpower = PROFILE_TO_BRAINPOWER[agent.profile] ?? agent.profile;
  const think =
    agent.thinkMode === 'on'
      ? 'on (thinks before answering)'
      : agent.thinkMode === 'off'
        ? 'off (answers fast)'
        : 'auto (the model decides)';
  const solo =
    agent.mode === 'autonomous'
      ? 'on (works a goal on its own)'
      : 'off (one turn at a time)';
  const tools =
    agent.toolAllowlist === null
      ? 'all tools'
      : agent.toolAllowlist.length === 0
        ? 'no tools'
        : agent.toolAllowlist.join(', ');
  const lines = [
    `${agent.name}${agent.role ? ` — ${agent.role}` : ''}`,
    `• brainpower: ${brainpower}`,
    `• think: ${think}`,
    `• solo: ${solo}`,
    `• delegate: ${agent.canDelegate ? 'on' : 'off'}`,
    `• rounds: ${agent.maxToolRounds}`,
    `• tools: ${tools}`,
  ];
  if (agent.origin) lines.push(`(provided by ${agent.origin} — read-only)`);
  return lines.join('\n');
}
