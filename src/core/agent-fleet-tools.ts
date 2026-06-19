// Main-chat fleet control (the "Modulus Agent" powers): dispatch work to any
// named agent, read what the whole fleet is doing, and pause/resume/cancel an
// agent's work — all from conversation.
//
// These are chat-only by design, the same split as escalate_to_agent
// (agent-escalation.ts): start.ts registers them on the full registry and
// hides them from every agent's tool view, because an agent steering the
// queue it runs on (or its siblings) would defeat the delegation model
// (spawn_agent, with its depth cap and grant intersection). The isAgentChatId
// refusal below is defence in depth, not the only guard.

import type { Logger } from '../util/log.js';
import type { ToolRegistry } from './tools.js';
import {
  isAgentChatId,
  AGENT_TASK_CANCELLED_MESSAGE,
  type AgentDefinition,
  type AgentRegistry,
  type AgentTask,
} from './agents.js';
import type { AgentQueue } from './agent-queue.js';

export const DISPATCH_AGENT_TOOL_NAME = 'dispatch_agent';
export const FLEET_STATUS_TOOL_NAME = 'agent_fleet_status';
export const MANAGE_AGENT_TASKS_TOOL_NAME = 'manage_agent_tasks';

export const FLEET_TOOL_NAMES: readonly string[] = [
  DISPATCH_AGENT_TOOL_NAME,
  FLEET_STATUS_TOOL_NAME,
  MANAGE_AGENT_TASKS_TOOL_NAME,
];

export interface AgentFleetToolsDeps {
  tools: ToolRegistry;
  registry: AgentRegistry;
  queue: AgentQueue;
  // Only cancellation is needed; the slim shape keeps tests honest.
  runtime: { cancelTask(taskId: number): boolean };
  log: Logger;
}

const AGENT_ONLY_REFUSAL = 'is for the main chat; agents delegate with spawn_agent instead.';

function rosterNames(registry: AgentRegistry): string {
  const names = registry.list().map((a) => a.name);
  return names.length > 0 ? names.join(', ') : '(no agents exist yet)';
}

function findAgent(registry: AgentRegistry, raw: unknown): AgentDefinition | undefined {
  const name = String(raw ?? '').trim();
  if (!name) return undefined;
  // Exact first, then case-insensitive — chat models love to re-case names.
  return (
    registry.getByName(name) ??
    registry.list().find((a) => a.name.toLowerCase() === name.toLowerCase())
  );
}

function clip(text: string, n: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

export function setupAgentFleetTools(deps: AgentFleetToolsDeps): void {
  const log = deps.log.child({ mod: 'agent-fleet-tools' });

  deps.tools.register({
    name: DISPATCH_AGENT_TOOL_NAME,
    description:
      'Send a background task to a specific agent in the fleet, by name. The agent works it on ' +
      'the queue with its own persona and tools and the user can watch it in the Agents tab. ' +
      `Use ${FLEET_STATUS_TOOL_NAME} first if you are unsure which agents exist or what they do. ` +
      'For long open-ended goals with no obvious agent, prefer escalate_to_agent.',
    tier: 'auto',
    selfReplying: true,
    parameters: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Exact name of the agent to dispatch to.' },
        task: {
          type: 'string',
          description:
            'The task, as a clear standalone instruction with all needed context (the agent ' +
            'cannot see this chat). State the desired end result.',
        },
      },
      required: ['agent', 'task'],
    },
    invoke: async (args, ctx) => {
      if (ctx.chatId !== undefined && isAgentChatId(ctx.chatId)) {
        return `${DISPATCH_AGENT_TOOL_NAME} ${AGENT_ONLY_REFUSAL}`;
      }
      const task = String(args['task'] ?? '').trim();
      if (!task) return 'A `task` describing the work is required.';
      const agent = findAgent(deps.registry, args['agent']);
      if (!agent) {
        return `No agent named "${String(args['agent'] ?? '').trim()}". Agents: ${rosterNames(deps.registry)}.`;
      }
      const queued = deps.registry.enqueue({
        agentId: agent.id,
        prompt: task,
        executionMode: agent.executionMode,
      });
      deps.queue.notify();
      log.info('dispatched task to agent', { agent: agent.name, task: queued.id });
      return `Dispatched task #${queued.id} to ${agent.name}. It runs in the background — progress is in the Agents tab.`;
    },
  });

  deps.tools.register({
    name: FLEET_STATUS_TOOL_NAME,
    description:
      'List every agent in the fleet and what it is doing right now: role, mode, and its ' +
      'running / queued / paused task counts with the latest task result. Use this to answer ' +
      '"what are my agents doing?" or before dispatching work to a specific agent.',
    tier: 'auto',
    parameters: { type: 'object', properties: {} },
    invoke: async (_args, ctx) => {
      if (ctx.chatId !== undefined && isAgentChatId(ctx.chatId)) {
        return `${FLEET_STATUS_TOOL_NAME} ${AGENT_ONLY_REFUSAL}`;
      }
      const agents = deps.registry.list();
      if (agents.length === 0) return 'The fleet is empty — no agents exist yet.';
      const lines = agents.map((a) => {
        const tasks = deps.registry.listTasks({ agentId: a.id, limit: 200 });
        const count = (s: AgentTask['status']): number =>
          tasks.filter((t) => t.status === s).length;
        const active = `${count('running')} running, ${count('queued')} queued, ${count('paused')} paused`;
        const latest = tasks.find((t) => t.status === 'done' && t.result);
        const last = latest ? ` Last result: ${clip(latest.result!, 120)}` : '';
        const role = a.role ? ` — ${a.role}` : '';
        return `- ${a.name} (${a.mode}, ${a.profile})${role}: ${active}.${last}`;
      });
      return ['Fleet status:', ...lines].join('\n');
    },
  });

  deps.tools.register({
    name: MANAGE_AGENT_TASKS_TOOL_NAME,
    description:
      "Pause, resume, or cancel ALL of one agent's background tasks, by agent name. Use when " +
      'the user asks to stop, pause, or resume what an agent is doing.',
    tier: 'confirm',
    confirmPrompt: (args) =>
      `${String(args['action'] ?? 'change')} all tasks for agent "${String(args['agent'] ?? '?')}"?`,
    parameters: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Exact name of the agent.' },
        action: {
          type: 'string',
          enum: ['pause', 'resume', 'cancel'],
          description: 'What to do with that agent’s tasks.',
        },
      },
      required: ['agent', 'action'],
    },
    invoke: async (args, ctx) => {
      if (ctx.chatId !== undefined && isAgentChatId(ctx.chatId)) {
        return `${MANAGE_AGENT_TASKS_TOOL_NAME} ${AGENT_ONLY_REFUSAL}`;
      }
      const action = String(args['action'] ?? '').trim();
      if (!['pause', 'resume', 'cancel'].includes(action)) {
        return 'Action must be one of: pause, resume, cancel.';
      }
      const agent = findAgent(deps.registry, args['agent']);
      if (!agent) {
        return `No agent named "${String(args['agent'] ?? '').trim()}". Agents: ${rosterNames(deps.registry)}.`;
      }
      // Mirrors the panel's per-agent bulk routes (src/panel/routes/agents.ts).
      let count = 0;
      if (action === 'pause') {
        for (const t of deps.registry.listTasks({
          agentId: agent.id,
          status: ['queued', 'running'],
        })) {
          deps.registry.updateTask(t.id, { status: 'paused', pausedUntil: null });
          count++;
        }
      } else if (action === 'resume') {
        for (const t of deps.registry.listTasks({ agentId: agent.id, status: 'paused' })) {
          deps.registry.updateTask(t.id, { status: 'queued', pausedUntil: null });
          count++;
        }
        deps.queue.notify();
      } else {
        for (const t of deps.registry.listTasks({
          agentId: agent.id,
          status: ['queued', 'running', 'paused'],
        })) {
          // cancelTask also aborts a running turn, but refuses paused rows —
          // mark those terminal directly (same split as the panel route).
          if (t.status === 'paused') {
            deps.registry.updateTask(t.id, {
              status: 'cancelled',
              error: AGENT_TASK_CANCELLED_MESSAGE,
              finishedAt: Date.now(),
            });
          } else {
            deps.runtime.cancelTask(t.id);
          }
          count++;
        }
      }
      log.info('fleet task action', { agent: agent.name, action, count });
      const verb = action === 'pause' ? 'Paused' : action === 'resume' ? 'Resumed' : 'Cancelled';
      return count === 0
        ? `${agent.name} has no tasks to ${action}.`
        : `${verb} ${count} task${count === 1 ? '' : 's'} for ${agent.name}.`;
    },
  });
}
