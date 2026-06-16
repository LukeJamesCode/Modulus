// One-request dispatch — pick the best agent for a task when the user didn't
// name one. Hybrid by design: a cheap deterministic rules pass handles the
// obvious cases with no model call, and only genuinely ambiguous tasks fall
// through to a tiny-model classification. Mirrors the instant-responses shape:
// decide from text first, reach for the model only when text isn't enough.
//
// Pure-ish: no DB, no enqueue. The caller (Telegram handleDispatch, panel
// /dispatch-auto) owns the registry write. Never throws into the caller — a
// model error or parse-fail resolves to null ("no specialist fits").

import type { AgentDefinition } from './agents.js';
import type { LLM } from './llm.js';
import type { Logger } from '../util/log.js';
import { getTemplate } from './agent-templates.js';

export interface ChooseAgentInput {
  task: string;
  agents: AgentDefinition[];
  llm: LLM;
  log: Logger;
}

export interface AgentChoice {
  agentId: number;
  agentName: string;
  via: 'rule' | 'model';
}

// Common words that carry no routing signal. Small on purpose — the keyword
// overlap is forgiving (prefix match), so we only need to drop true noise.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'about', 'into', 'from', 'your', 'you',
  'can', 'please', 'help', 'need', 'want', 'make', 'get', 'find', 'give', 'tell', 'show',
  'have', 'has', 'are', 'was', 'will', 'would', 'should', 'could', 'some', 'any', 'how',
  'what', 'when', 'where', 'who', 'why', 'best', 'good', 'new', 'out', 'all',
]);

function tokenize(text: string): string[] {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

// A task token "matches" an agent token on exact equality, or on a shared
// prefix for longer tokens (so "research" hits the "researcher" persona).
function tokenMatches(taskTok: string, agentToks: Set<string>): boolean {
  if (agentToks.has(taskTok)) return true;
  if (taskTok.length < 4) return false;
  for (const a of agentToks) {
    if (a.length >= 4 && (a.startsWith(taskTok) || taskTok.startsWith(a))) return true;
  }
  return false;
}

// The keyword set that represents an agent: its name + role, enriched with the
// matching template's title/description when the agent was hired from one
// (matched by name, since a template's id is its suggested agent name).
function agentKeywords(agent: AgentDefinition): Set<string> {
  const parts = [agent.name, agent.role];
  const tmpl = getTemplate(agent.name);
  if (tmpl) parts.push(tmpl.title, tmpl.description);
  const toks = new Set<string>();
  for (const p of parts) for (const t of tokenize(p)) toks.add(t);
  toks.add(agent.name.toLowerCase()); // keep the bare name even if short/stopword
  return toks;
}

// Rules pass: score every agent by keyword overlap, return the unambiguous
// winner (top score ≥ 1 and strictly ahead of the runner-up), else null so the
// caller escalates to the model.
function ruleChoice(task: string, agents: AgentDefinition[]): AgentChoice | null {
  const taskToks = [...new Set(tokenize(task))];
  if (taskToks.length === 0) return null;
  const scored = agents
    .map((a) => {
      const ak = agentKeywords(a);
      let score = 0;
      for (const t of taskToks) if (tokenMatches(t, ak)) score++;
      return { a, score };
    })
    .sort((x, y) => y.score - x.score);
  const top = scored[0];
  const runner = scored[1];
  if (top && top.score >= 1 && (!runner || top.score > runner.score)) {
    return { agentId: top.a.id, agentName: top.a.name, via: 'rule' };
  }
  return null;
}

// Collect a bounded, non-streaming completion from the tiny model.
async function complete(llm: LLM, task: string, agents: AgentDefinition[]): Promise<string> {
  const roster = agents
    .map((a) => `- ${a.name}: ${(a.role || a.systemPrompt).slice(0, 80)}`)
    .join('\n');
  const messages = [
    {
      role: 'system' as const,
      content:
        'You route a task to exactly ONE agent. Reply with only the agent name from the list, ' +
        'copied exactly, or the single word NONE if none fit. No punctuation, no explanation.',
    },
    {
      role: 'user' as const,
      content: `Agents:\n${roster}\n\nTask: ${task}\n\nBest agent name (or NONE):`,
    },
  ];
  let out = '';
  for await (const chunk of llm.chat({ profile: 'chat', messages, maxTokens: 16, thinkMode: 'off' })) {
    out += chunk.delta ?? '';
  }
  return out;
}

// Parse the model's reply into a fleet agent, or null on NONE / parse-fail.
function parseModelChoice(reply: string, agents: AgentDefinition[]): AgentChoice | null {
  const cleaned = reply
    .toLowerCase()
    .replace(/[^a-z0-9_ -]+/g, ' ')
    .trim();
  if (!cleaned || cleaned === 'none' || cleaned.split(/\s+/)[0] === 'none') return null;
  const tokens = new Set(cleaned.split(/\s+/));
  const exact = agents.find((a) => tokens.has(a.name.toLowerCase()));
  const fuzzy = exact ?? agents.find((a) => cleaned.includes(a.name.toLowerCase()));
  return fuzzy ? { agentId: fuzzy.id, agentName: fuzzy.name, via: 'model' } : null;
}

export async function chooseAgentForTask(input: ChooseAgentInput): Promise<AgentChoice | null> {
  const { task, agents, llm, log } = input;
  if (agents.length === 0 || !task.trim()) return null;

  const ruled = ruleChoice(task, agents);
  if (ruled) return ruled;

  // Ambiguous — ask the tiny model. Any failure resolves to "no fit".
  try {
    const reply = await complete(llm, task, agents);
    const choice = parseModelChoice(reply, agents);
    if (!choice) log.warn('agent-router: model returned no usable choice', { reply: reply.slice(0, 60) });
    return choice;
  } catch (e) {
    log.warn('agent-router: model classification failed', {
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}
