// Pure command logic for the agent surface (/agents, /dispatch). Kept out of
// the grammY adapter so it can be unit-tested and reused by other chat
// surfaces (e.g. modulus-discord) without touching Telegram I/O.

import type { AgentRegistry, AgentTask } from '../core/agents.js';
import type { AgentQueue } from '../core/agent-queue.js';
import type { LLM } from '../core/llm.js';
import { ingestFiles } from '../core/agent-attachments.js';

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
export function parseDispatch(arg: string): { agentName: string; task: string } | { error: string } {
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
export function handleDispatch(
  registry: AgentRegistry,
  queue: AgentQueue | undefined,
  arg: string,
): string {
  const parsed = parseDispatch(arg);
  if ('error' in parsed) return parsed.error;

  const agent = registry.getByName(parsed.agentName);
  if (!agent) return `No agent named '${parsed.agentName}'. Run /agents to see them.`;

  const enqueued = queue
    ? queue.dispatch({ agentId: agent.id, prompt: parsed.task })
    : registry.enqueue({ agentId: agent.id, prompt: parsed.task });
  return `Dispatched task #${enqueued.id} to ${agent.name}. Track it in the panel (Agents → Tasks).`;
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
}): Promise<string> {
  const parsed = parseDispatch(deps.arg);
  if ('error' in parsed) return parsed.error;

  const agent = deps.registry.getByName(parsed.agentName);
  if (!agent) return `No agent named '${parsed.agentName}'. Run /agents to see them.`;

  const model = deps.llm.resolveModel(agent.profile);
  const allowVisual = deps.llm.supportsVision ? await deps.llm.supportsVision(model) : false;

  const enqueued = deps.queue
    ? deps.queue.dispatch({ agentId: agent.id, prompt: parsed.task })
    : deps.registry.enqueue({ agentId: agent.id, prompt: parsed.task });

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
  return `Dispatched task #${enqueued.id} to ${agent.name}${attached}. Track it in the panel (Agents → Tasks).${skipped}`;
}
