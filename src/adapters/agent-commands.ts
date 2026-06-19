// Pure command logic for the agent surface (/agents, /dispatch). Kept out of
// the grammY adapter so it can be unit-tested and reused by other chat
// surfaces (e.g. modulus-discord) without touching Telegram I/O.

import type { AgentDefinition, AgentRegistry, AgentTask } from '../core/agents.js';
import type { AgentQueue } from '../core/agent-queue.js';
import type { LLM } from '../core/llm.js';
import type { Logger } from '../util/log.js';
import { ingestFiles } from '../core/agent-attachments.js';
import { chooseAgentForTask } from '../core/agent-router.js';
import { AGENT_TEMPLATES, getTemplate, hireFromTemplate } from '../core/agent-templates.js';
import { applyKnob, describeAgentPlain, PLAIN_KNOB_NAMES } from '../core/agent-knobs.js';

// Routing deps for one-request dispatch (`/dispatch <task>` with no agent
// named). Optional on handleDispatch so the pure-handler tests and non-routing
// surfaces keep the old "name an agent" behavior when omitted.
export interface DispatchRouteDeps {
  llm: LLM;
  log: Logger;
}

// Render the fleet for `/agents`: one line per persona with its role, model,
// whether it delegates, and the status of its most recent task.
export function formatAgentList(registry: AgentRegistry): string {
  const agents = registry.list();
  if (agents.length === 0) {
    return 'No agents defined yet. Create one in the web panel (Agents tab).';
  }
  const recent = registry.listTasks({ limit: 200 });
  const latestByAgent = new Map<number, AgentTask>();
  for (const t of recent) {
    if (!latestByAgent.has(t.agentId)) latestByAgent.set(t.agentId, t);
  }
  const lines = agents.map((a) => {
    const last = latestByAgent.get(a.id);
    const status = last ? ` · last: ${last.status}` : '';
    const deleg = a.canDelegate ? ' · delegates' : '';
    return `• ${a.name} — ${a.role || a.profile} (${a.profile})${deleg}${status}`;
  });
  return [
    'Agents:',
    ...lines,
    '',
    'Dispatch a task:  /dispatch <agent> <task>',
    'Attach a file:  send a photo or document with that caption (images/PDFs need a vision model).',
  ].join('\n');
}

// Split `/dispatch <agent> <task>`'s argument into the agent name and the task
// prompt, or return a usage error. Shared by the text and attachment paths.
export function parseDispatch(
  arg: string,
): { agentName: string; task: string } | { error: string } {
  const trimmed = arg.trim();
  if (!trimmed) return { error: 'Usage: /dispatch <agent> <task>' };
  const sep = trimmed.search(/\s/);
  if (sep === -1) {
    return { error: 'Usage: /dispatch <agent> <task> — add the task after the agent name.' };
  }
  const task = trimmed.slice(sep + 1).trim();
  if (!task) return { error: 'Usage: /dispatch <agent> <task> — the task is empty.' };
  return { agentName: trimmed.slice(0, sep), task };
}

// Enqueue a task from `/dispatch <agent> <task>`. Returns the user-facing reply.
// Uses the queue (which kicks the scheduler) when available, falling back to a
// plain enqueue so the task is at least persisted if the queue isn't wired.
// `notifyChatId` records the chat to ping when the task finishes (see
// formatTaskNotification); omit it for surfaces that don't deliver notifications.
// Enqueue + render the reply for a resolved (agent, task). `auto` switches the
// wording between the explicit form and the auto-picked "Sent to <agent>" form.
function enqueueDispatch(
  registry: AgentRegistry,
  queue: AgentQueue | undefined,
  agentId: number,
  agentName: string,
  task: string,
  notifyChatId: number | null | undefined,
  auto: boolean,
): string {
  const input = { agentId, prompt: task, notifyChatId: notifyChatId ?? null };
  const enqueued = queue ? queue.dispatch(input) : registry.enqueue(input);
  const ping = notifyChatId != null ? " I'll message you when it's done." : '';
  return auto
    ? `Sent to ${agentName} — task #${enqueued.id}.${ping}`
    : `Dispatched task #${enqueued.id} to ${agentName}.${ping}`;
}

export async function handleDispatch(
  registry: AgentRegistry,
  queue: AgentQueue | undefined,
  arg: string,
  notifyChatId?: number | null,
  route?: DispatchRouteDeps,
): Promise<string> {
  const trimmed = arg.trim();
  if (!trimmed) {
    return 'Usage: /dispatch <agent> <task> — or just /dispatch <task> and I’ll pick an agent.';
  }
  const sep = trimmed.search(/\s/);
  const firstToken = sep === -1 ? trimmed : trimmed.slice(0, sep);
  const named = registry.getByName(firstToken);

  // Explicit form: the first token is a known agent.
  if (named) {
    const task = sep === -1 ? '' : trimmed.slice(sep + 1).trim();
    if (!task) return 'Usage: /dispatch <agent> <task> — add the task after the agent name.';
    return enqueueDispatch(registry, queue, named.id, named.name, task, notifyChatId, false);
  }

  // No agent by that name. Without routing deps, keep the old error (the pure-
  // handler tests and non-routing surfaces rely on this).
  if (!route) return `No agent named '${firstToken}'. Run /agents to see them.`;

  // One-request dispatch: treat the whole line as a task and auto-pick an agent.
  const choice = await chooseAgentForTask({
    task: trimmed,
    agents: registry.list(),
    llm: route.llm,
    log: route.log,
  });
  if (!choice) {
    return "I couldn't find a specialist that fits that. Try /dispatch <agent> <task>, or /agents to see who's available.";
  }
  return enqueueDispatch(
    registry,
    queue,
    choice.agentId,
    choice.agentName,
    trimmed,
    notifyChatId,
    true,
  );
}

// Enqueue a `/dispatch <agent> <task>` that arrived with attached files (a
// Telegram photo/document, or any chat surface that can carry bytes). Files are
// already downloaded by the caller; image/PDF drops are gated on the agent's
// model being multimodal, refused with a note rather than fed to a blind model.
// Order: enqueue, then ingest the (in-memory) files into the new task's dir
// before the queue's next poll — same contract the web panel uses.
export async function handleDispatchWithAttachments(deps: {
  registry: AgentRegistry;
  queue: AgentQueue | undefined;
  llm: Pick<LLM, 'resolveModel' | 'supportsVision'>;
  baseDir: string;
  arg: string;
  files: Array<{ name: string; bytes: Buffer; mime?: string }>;
  notifyChatId?: number | null;
}): Promise<string> {
  const parsed = parseDispatch(deps.arg);
  if ('error' in parsed) return parsed.error;

  const agent = deps.registry.getByName(parsed.agentName);
  if (!agent) return `No agent named '${parsed.agentName}'. Run /agents to see them.`;

  const model = deps.llm.resolveModel(agent.profile);
  const allowVisual = deps.llm.supportsVision ? await deps.llm.supportsVision(model) : false;

  const input = {
    agentId: agent.id,
    prompt: parsed.task,
    notifyChatId: deps.notifyChatId ?? null,
  };
  const enqueued = deps.queue ? deps.queue.dispatch(input) : deps.registry.enqueue(input);

  const { ingested, rejected } = await ingestFiles({
    registry: deps.registry,
    baseDir: deps.baseDir,
    taskId: enqueued.id,
    allowVisual,
    files: deps.files.map((f) => ({
      relPath: f.name,
      bytes: f.bytes,
      ...(f.mime ? { mime: f.mime } : {}),
    })),
  });

  const attached = ingested > 0 ? ` with ${ingested} attachment${ingested === 1 ? '' : 's'}` : '';
  const skipped = rejected.length ? `\nSkipped: ${rejected.join('; ')}` : '';
  const tail = deps.notifyChatId != null ? " I'll message you here when it's done." : '';
  return `Dispatched task #${enqueued.id} to ${agent.name}${attached}.${tail}${skipped}`;
}

// Telegram caps a message at 4096 chars; leave headroom for the header so a long
// task result still fits a single notification.
const NOTIFY_RESULT_CAP = 3500;

// Render the done/failed message sent to the chat that dispatched a task, once
// the task reaches a terminal state. Pure so it's testable without I/O. Returns
// null for states that shouldn't notify — still in flight, or user-cancelled
// (the user initiated that, so a ping would be noise).
export function formatTaskNotification(task: AgentTask, agentName: string): string | null {
  const tag = `Task #${task.id} (${agentName})`;
  if (task.status === 'done') {
    const body = (task.result ?? '').trim();
    const shown =
      body.length > NOTIFY_RESULT_CAP ? `${body.slice(0, NOTIFY_RESULT_CAP)}\n… (truncated)` : body;
    return shown ? `✅ ${tag} finished:\n\n${shown}` : `✅ ${tag} finished.`;
  }
  if (task.status === 'error') {
    return `⚠️ ${tag} failed: ${(task.error ?? 'unknown error').trim()}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Agent CRUD from chat (Telegram) — composable pure handlers, one per command,
// each returning the user-facing reply. The grammY wiring is thin I/O on top.
// ---------------------------------------------------------------------------

// Mirrors the loader's AGENT_NAME_RE (modules.ts) so a chat-created name has the
// same shape as a manifest/panel one.
const AGENT_NAME_RE = /^[a-z0-9][a-z0-9_-]{1,40}$/i;

function templateIdList(): string {
  return AGENT_TEMPLATES.map((t) => t.id).join(', ');
}

// Only user-created agents (origin null) are editable/firable. Module-provided
// agents (origin 'module:<name>') are owned by the loader — never mutate them.
function isModuleOwned(agent: AgentDefinition): boolean {
  return typeof agent.origin === 'string' && agent.origin.startsWith('module:');
}

// Resolve a name to a user-editable agent, or return the guard/usage error.
// Shared by /agent set|prompt|role and /fire so the same guards apply everywhere.
export function findEditableAgent(
  registry: AgentRegistry,
  name: string,
): { agent: AgentDefinition } | { error: string } {
  const trimmed = name.trim();
  const agent = registry.getByName(trimmed);
  if (!agent) return { error: `No agent named '${trimmed}'. Run /agents to see them.` };
  if (isModuleOwned(agent)) {
    return {
      error: `'${agent.name}' is provided by ${agent.origin} — it can't be edited or removed.`,
    };
  }
  return { agent };
}

// /hire <template> [name] — instantiate a curated persona (Phase 1 catalog).
// The name is the whole remainder after the template id, so an accidental
// multi-word name is rejected by the name check rather than silently truncated.
export function handleHire(registry: AgentRegistry, arg: string): string {
  const trimmed = arg.trim();
  if (!trimmed) return `Usage: /hire <template> [name]. Templates: ${templateIdList()}.`;
  const sep = trimmed.search(/\s/);
  const id = sep === -1 ? trimmed : trimmed.slice(0, sep);
  const name = sep === -1 ? '' : trimmed.slice(sep + 1).trim();
  const template = getTemplate(id);
  if (!template) return `No template '${id}'. Templates: ${templateIdList()}.`;
  if (name && !AGENT_NAME_RE.test(name)) {
    return 'Name must be letters, numbers, - or _ (2–41 chars, no spaces).';
  }
  const input = hireFromTemplate(template, name || undefined);
  if (registry.getByName(input.name)) {
    return `An agent named '${input.name}' already exists. Try: /hire ${id} <another-name>.`;
  }
  const agent = registry.create(input);
  return `Hired ${agent.name} (${template.title}). View it with /agent ${agent.name}.`;
}

// /newagent <name> — a minimal custom agent the user then configures with the
// /agent <name> set|prompt|role commands.
export function handleNewAgent(registry: AgentRegistry, arg: string): string {
  const name = arg.trim();
  if (!name) return 'Usage: /newagent <name>';
  if (!AGENT_NAME_RE.test(name)) {
    return 'Name must be letters, numbers, - or _ (2–41 chars, no spaces).';
  }
  if (registry.getByName(name)) return `An agent named '${name}' already exists.`;
  const agent = registry.create({
    name,
    role: '',
    systemPrompt: `You are ${name}, a helpful assistant.`,
    profile: 'chat',
  });
  return [
    `Created ${agent.name}. Set it up:`,
    `• /agent ${name} role <one line>`,
    `• /agent ${name} prompt <what it should do>`,
    `• /agent ${name} set brainpower quick|balanced|deep`,
  ].join('\n');
}

// /agent <name>                      → plain-language summary (read)
// /agent <name> set <knob> <value>   → applyKnob → reg.update
// /agent <name> prompt <text>        → set systemPrompt
// /agent <name> role <text>          → set role
export function handleAgentCommand(registry: AgentRegistry, arg: string): string {
  const trimmed = arg.trim();
  if (!trimmed) return 'Usage: /agent <name> [set <knob> <value> | prompt <text> | role <text>]';
  const sep = trimmed.search(/\s/);
  const name = sep === -1 ? trimmed : trimmed.slice(0, sep);
  const rest = sep === -1 ? '' : trimmed.slice(sep + 1).trim();

  // Read is allowed for any agent (including module-owned, marked read-only).
  const found = registry.getByName(name);
  if (!found) return `No agent named '${name}'. Run /agents to see them.`;
  if (!rest) return describeAgentPlain(found);

  // Every update path needs a user-editable agent.
  const editable = findEditableAgent(registry, name);
  if ('error' in editable) return editable.error;
  const agent = editable.agent;

  const subSep = rest.search(/\s/);
  const sub = (subSep === -1 ? rest : rest.slice(0, subSep)).toLowerCase();
  const subArg = subSep === -1 ? '' : rest.slice(subSep + 1).trim();

  if (sub === 'prompt') {
    if (!subArg) return `Usage: /agent ${name} prompt <text>`;
    registry.update(agent.id, { systemPrompt: subArg });
    return `Updated ${agent.name}'s prompt.`;
  }
  if (sub === 'role') {
    if (!subArg) return `Usage: /agent ${name} role <text>`;
    registry.update(agent.id, { role: subArg });
    return `Updated ${agent.name}'s role.`;
  }
  if (sub === 'set') {
    const kSep = subArg.search(/\s/);
    const knob = kSep === -1 ? subArg : subArg.slice(0, kSep);
    const value = kSep === -1 ? '' : subArg.slice(kSep + 1).trim();
    if (!knob || !value) {
      return `Usage: /agent ${name} set <knob> <value>. Knobs: ${PLAIN_KNOB_NAMES.join(', ')}.`;
    }
    const result = applyKnob({}, knob, value);
    if ('error' in result) return result.error;
    registry.update(agent.id, result.patch);
    return `Set ${agent.name}: ${knob.toLowerCase()} = ${value}.`;
  }
  return `Unknown command '${sub}'. Try set, prompt, or role — or /agent ${name} to view it.`;
}

// /fire <name> — the guarded deletion, run after the inline Yes/No confirm.
export function handleFire(registry: AgentRegistry, name: string): string {
  const editable = findEditableAgent(registry, name);
  if ('error' in editable) return editable.error;
  registry.remove(editable.agent.id);
  return `Fired ${editable.agent.name}. Its task history stays.`;
}
