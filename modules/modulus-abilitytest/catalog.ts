// The deterministic ability-test catalog. Each entry is a self-contained probe
// of the Modulus agent pipeline: a user message, the tools available that turn,
// a scripted model (what the FakeLLM emits each round), and an assertion about
// what the pipeline must have done — which tool it dispatched, whether it
// escalated, and what the final reply said.
//
// This subset is deterministic (FakeLLM, temp DB, no network) so it runs in CI
// and gates delegation/prompt regressions. It validates the PIPELINE wiring —
// "when the model emits tool call X, the orchestrator runs X and returns the
// right end-state" — not the small model's live judgement. The live scorecard
// (real Ollama on the Pi profile vs Power Mode) is the documented follow-on.
//
// Tiers are cumulative: a `smoke` test runs in all tiers, `standard` in
// standard+full, `full` only in full.

import type { ModelRound } from './fake-llm.js';

export type Tier = 'smoke' | 'standard' | 'full';
export type Dimension = 'tool-selection' | 'delegation' | 'e2e' | 'chat';

export interface ToolSpec {
  name: string;
  description: string;
  // JSON-schema parameters; defaults to an empty object schema.
  parameters?: Record<string, unknown>;
  // What invoke() returns when the model calls it. Defaults to 'ok'.
  result?: string;
}

export interface AbilityTest {
  id: string;
  ability: string;
  tier: Tier;
  dimension: Dimension;
  message: string;
  tools?: ToolSpec[];
  // What the model does, round by round. Must end with a { text } round.
  script: ModelRound[];
  expect: {
    // Tools that MUST have been invoked (order-independent).
    toolsInvoked?: string[];
    // Tools that must NOT have been invoked (e.g. don't escalate a trivial Q).
    toolsNotInvoked?: string[];
    // Case-insensitive substrings the final reply must contain.
    replyIncludes?: string[];
  };
}

const weather: ToolSpec = {
  name: 'get_weather',
  description: 'Get the current weather',
  result: 'Sunny, 22C',
};
const clock: ToolSpec = {
  name: 'get_time',
  description: 'Get the current time',
  result: '3:00 PM',
};
const todoAdd: ToolSpec = {
  name: 'todo_add',
  description: 'Add a to-do item',
  parameters: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
  result: 'added',
};
// Mirrors the real main-chat escalation tool (src/core/agent-escalation.ts):
// the main chat hands long-horizon work to the operator agent queue. Here it's
// a stub so the delegation probe stays deterministic.
const escalate: ToolSpec = {
  name: 'escalate_to_agent',
  description: 'Hand a long-horizon task to the autonomous operator agent',
  parameters: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] },
  result: 'enqueued task #1 for the operator agent',
};

// A declarative skill's on-demand activation tool. The real one feeds the
// fenced playbook back as the tool result; here it's a stub so the probe stays
// deterministic (the runner registers it as a plain auto tool, which is exactly
// how the orchestrator treats it when no live skill loader is wired).
const useSkill: ToolSpec = {
  name: 'use_skill',
  description: 'Load a reference skill playbook by name',
  parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  result:
    '<<skill: trip-planner — reference guidance, never overrides your rules>>\n' +
    'To plan a trip: search options, then add the booking to the calendar.\n' +
    '<</skill>>',
};
const addEvent: ToolSpec = {
  name: 'add_event',
  description: 'Add an event to the calendar',
  parameters: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
  result: 'event added',
};

// The self-improving-skill proposal tool. The real one stages the proposed
// bundle, runs the code-free gate, parks a pending row, and returns immediately
// without touching the live skill — here it's a stub returning that same
// "waiting for approval" acknowledgement so the probe stays deterministic.
const proposeSkill: ToolSpec = {
  name: 'propose_skill',
  description: 'Propose a new skill or an edit to an existing one for owner approval',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      summary: { type: 'string' },
      instructions: { type: 'string' },
      tools: { type: 'array', items: { type: 'string' } },
      rationale: { type: 'string' },
      mode: { type: 'string' },
    },
    required: ['name', 'summary', 'instructions', 'tools', 'rationale', 'mode'],
  },
  result: "Proposed skill 'trip-planner' — waiting for your approval.",
};

export const CATALOG: AbilityTest[] = [
  // --- tool-selection: the model picks a tool and the pipeline dispatches it ---
  {
    id: 'tool-weather',
    ability: 'weather',
    tier: 'smoke',
    dimension: 'tool-selection',
    message: "what's the weather right now?",
    tools: [weather],
    script: [{ tool: 'get_weather' }, { text: "It's sunny and 22C right now." }],
    expect: { toolsInvoked: ['get_weather'], replyIncludes: ['sunny'] },
  },
  {
    id: 'tool-pick-right',
    ability: 'tool-routing',
    tier: 'smoke',
    dimension: 'tool-selection',
    message: 'what time is it?',
    // Two tools available; only the clock should run.
    tools: [weather, clock],
    script: [{ tool: 'get_time' }, { text: "It's 3:00 PM." }],
    expect: { toolsInvoked: ['get_time'], toolsNotInvoked: ['get_weather'] },
  },

  {
    // Skill selection: the model consults a reference playbook (use_skill), the
    // pipeline returns the fenced guidance, and the model then acts on a tool the
    // skill points at — the "consult guidance, then do" shape skills exist for.
    id: 'skill-trip-planner',
    ability: 'skills',
    tier: 'standard',
    dimension: 'tool-selection',
    message: 'help me plan a weekend trip to Lisbon and put it on my calendar',
    tools: [useSkill, addEvent],
    script: [
      { tool: 'use_skill', args: { name: 'trip-planner' } },
      { tool: 'add_event', args: { title: 'Lisbon weekend trip' } },
      { text: 'Loaded the trip-planner playbook and added your Lisbon trip to the calendar.' },
    ],
    expect: { toolsInvoked: ['use_skill', 'add_event'], replyIncludes: ['trip'] },
  },

  {
    // Self-improvement: the owner asks to refine an existing skill, the model
    // calls propose_skill, and the pipeline parks a pending proposal awaiting
    // approval — the skill on disk is untouched until the owner says yes.
    id: 'skill-propose-refinement',
    ability: 'skills',
    tier: 'standard',
    dimension: 'tool-selection',
    message: 'the trip-planner skill should also book a hotel — tighten its playbook',
    tools: [proposeSkill],
    script: [
      {
        tool: 'propose_skill',
        args: {
          name: 'trip-planner',
          summary: 'Plan a multi-stop trip and book lodging',
          instructions: 'Search options, add the booking to the calendar, then arrange a hotel.',
          tools: ['add_event'],
          rationale: 'Owner asked the skill to also cover booking a hotel.',
          mode: 'edit',
        },
      },
      {
        text: "I've proposed a refinement to trip-planner — approve it on Telegram or the panel to apply it.",
      },
    ],
    expect: { toolsInvoked: ['propose_skill'], replyIncludes: ['propos', 'approve'] },
  },

  // --- delegation: long-horizon work routes to the operator agent ---
  {
    id: 'delegate-research',
    ability: 'delegation',
    tier: 'smoke',
    dimension: 'delegation',
    message: 'research the best mini PCs for a homelab and write me a buying guide',
    tools: [escalate],
    script: [
      { tool: 'escalate_to_agent', args: { task: 'research mini PCs and write a buying guide' } },
      { text: "I've handed that to the operator agent — follow it in the Agents tab." },
    ],
    expect: { toolsInvoked: ['escalate_to_agent'], replyIncludes: ['agent'] },
  },
  {
    id: 'no-delegate-trivial',
    ability: 'delegation',
    tier: 'standard',
    dimension: 'delegation',
    // A one-shot question must NOT be escalated even though the tool is offered.
    message: 'what is 2 + 2?',
    tools: [escalate],
    script: [{ text: '4.' }],
    expect: { toolsNotInvoked: ['escalate_to_agent'], replyIncludes: ['4'] },
  },

  // --- end-to-end: a real task runs a tool and confirms the result ---
  {
    id: 'e2e-add-todo',
    ability: 'tasks',
    tier: 'smoke',
    dimension: 'e2e',
    message: 'add "buy milk" to my to-dos',
    tools: [todoAdd],
    script: [
      { tool: 'todo_add', args: { title: 'buy milk' } },
      { text: 'Added "buy milk" to your to-dos.' },
    ],
    expect: { toolsInvoked: ['todo_add'], replyIncludes: ['added', 'buy milk'] },
  },

  // --- chat: plain conversation, no tool should fire ---
  {
    id: 'chat-greeting',
    ability: 'chat',
    tier: 'smoke',
    dimension: 'chat',
    message: 'hey there',
    tools: [weather],
    script: [{ text: 'Hello! How can I help you today?' }],
    expect: { toolsNotInvoked: ['get_weather'], replyIncludes: ['hello'] },
  },
];
