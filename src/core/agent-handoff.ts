// The `handoff` tool — pass a live conversation to a peer agent (v2.0.0).
//
// Where spawn_agent (agent-delegation.ts) runs a child and waits, and
// escalate_to_agent (agent-escalation.ts) hands long work to the background
// operator, `handoff` does the third thing: the agent currently talking to the
// user on a chat surface decides a *different* agent should take over the
// conversation, and steps out. Effect: re-bind this chat to the target agent
// (ConversationRouter), then reply that the handover happened — the next user
// turn on this chat runs as the target's persona.
//
// A handoff is the dynamic writer of the same channel→agent binding state the
// user sets statically with /bind, so it lives next to the router, not the queue.
//
// Guards:
//   - Refuses inside a background agent task run (an agent there delegates with
//     spawn_agent; handoff is for a live, surface-bound conversation). Mirrors
//     escalate_to_agent's inverse guard.
//   - Honours the caller's delegatableAgents allowlist ([] = any), reusing the
//     delegation rule. The default Modulus agent (unbound chat) may hand off to
//     any agent. Handoff never widens a grant — the target runs with its own
//     consented tools, exactly as if the user had bound to it directly.
//   - Caps handoffs per chat in a rolling window so two agents can't ping-pong a
//     user back and forth.

import type { Logger } from '../util/log.js';
import type { ToolRegistry } from './tools.js';
import {
  isAgentChatId,
  intersectGrants,
  AGENT_CHAT_ID_BASE,
  MAX_DELEGATION_DEPTH,
  type AgentRegistry,
} from './agents.js';
import type { AgentQueue } from './agent-queue.js';
import type { ConversationRouter } from './conversation-routing.js';

export const HANDOFF_TOOL_NAME = 'handoff';
// Background-task handoff: an agent transfers its WHOLE task to a peer and stops.
export const HANDOFF_TASK_TOOL_NAME = 'handoff_task';

// Ping-pong guard: at most MAX handoffs per chat within WINDOW_MS.
const HANDOFF_WINDOW_MS = 60_000;
const MAX_HANDOFFS_PER_WINDOW = 3;

export interface AgentHandoffDeps {
  tools: ToolRegistry;
  router: ConversationRouter;
  registry: AgentRegistry;
  log: Logger;
  // Override the clock in tests.
  now?: () => number;
}

export function setupAgentHandoff(deps: AgentHandoffDeps): void {
  const log = deps.log.child({ mod: 'agent-handoff' });
  const now = deps.now ?? (() => Date.now());
  // chatId -> recent handoff timestamps (pruned to the window on each check).
  const recent = new Map<number, number[]>();

  function overPingPongCap(chatId: number): boolean {
    const t = now();
    const hist = (recent.get(chatId) ?? []).filter((ts) => t - ts < HANDOFF_WINDOW_MS);
    if (hist.length >= MAX_HANDOFFS_PER_WINDOW) {
      recent.set(chatId, hist);
      return true;
    }
    hist.push(t);
    recent.set(chatId, hist);
    return false;
  }

  deps.tools.register({
    name: HANDOFF_TOOL_NAME,
    description:
      'Hand this conversation over to another agent who is a better fit, and step out. ' +
      'From now on the user talks to that agent instead of you. Use it when the request really ' +
      "belongs to a specialist (e.g. you're the general assistant and the user now needs the coder). " +
      'Give a short note describing what the user wants so the next agent has context. Do NOT use it ' +
      'for a subtask you should do yourself or delegate and wait on — this transfers the whole chat.',
    tier: 'auto',
    selfReplying: true,
    parameters: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Name of the agent to hand the conversation to.' },
        note: {
          type: 'string',
          description: 'A short summary of what the user needs, shown when handing over.',
        },
      },
      required: ['agent'],
    },
    invoke: async (args, ctx) => {
      const chatId = ctx.chatId;
      if (chatId === undefined) {
        return 'handoff needs a conversation to transfer, but none was resolved.';
      }
      // A background agent task delegates with spawn_agent; handoff is only for a
      // live chat-surface conversation. Agents never see this tool (start.ts hides
      // it from agentTools), so this is defence in depth.
      if (isAgentChatId(chatId)) {
        return 'handoff is for a live conversation; inside an agent run, delegate with spawn_agent instead.';
      }

      const targetName = String(args['agent'] ?? '').trim();
      if (!targetName) return 'An `agent` to hand the conversation to is required.';
      const target = deps.registry.getByName(targetName);
      if (!target) return `No agent named '${targetName}'.`;

      // The agent currently driving this chat: the bound agent, or the default
      // Modulus agent when the chat is unbound. The caller's delegatableAgents
      // (when set) gate who it may hand off to; the default agent may hand off to
      // anyone.
      const callerId = deps.router.boundAgentId(chatId);
      const caller = callerId !== null ? deps.registry.get(callerId) : undefined;
      const callerName = caller?.name ?? 'assistant';
      if (caller && callerId === target.id) {
        return `You're already the agent on this conversation; no handoff needed.`;
      }
      if (
        caller &&
        caller.delegatableAgents.length > 0 &&
        !caller.delegatableAgents.includes(targetName)
      ) {
        return `Agent '${caller.name}' may not hand off to '${targetName}'.`;
      }

      if (overPingPongCap(chatId)) {
        return `Too many handoffs on this conversation just now; staying with ${callerName}.`;
      }

      const bound = deps.router.bind(chatId, target.id, `handoff:${callerName}`);
      if (!bound) return `Could not hand off to '${targetName}'.`;
      log.info('handed off conversation', { chatId, from: callerName, to: targetName });

      const note = String(args['note'] ?? '').trim();
      return note
        ? `Handing you over to ${target.name} — ${note}`
        : `Handing you over to ${target.name}.`;
    },
  });
}

// ---------------------------------------------------------------------------
// handoff_task — the background-run counterpart. Where the chat `handoff` rebinds
// a live conversation, this transfers an agent's whole TASK to a peer and stops.
//
// Safe by construction: it never touches the running task's row (no reassign +
// requeue, which would risk a double-run with the in-flight run still unwinding).
// It enqueues a FRESH successor task for the target, carrying the goal, the
// original's notify chat (so the handoff is transparent to the requester), the
// caller's grant ceiling (so a handoff can't escalate privilege — same rule as
// spawn_agent), and depth+1 (so handoff chains are bounded like delegation). The
// caller's own run then finishes on its own; the tool is selfReplying, and its
// description tells the model its work is done.
// ---------------------------------------------------------------------------

export interface TaskHandoffDeps {
  tools: ToolRegistry;
  registry: AgentRegistry;
  queue: AgentQueue;
  log: Logger;
}

export function setupTaskHandoff(deps: TaskHandoffDeps): void {
  const log = deps.log.child({ mod: 'agent-handoff' });

  deps.tools.register({
    name: HANDOFF_TASK_TOOL_NAME,
    description:
      'Hand the WHOLE task you are working on to another agent, then stop. The new agent picks it ' +
      'up, works it with its own tools, and reports back where this task would have. Use it when the ' +
      'task really belongs to a different specialist. This is NOT spawn_agent (which keeps you in ' +
      'charge and waits for a helper) — after calling this your work here is done, so finish. Restate ' +
      'the goal in full; the new agent cannot see your run.',
    tier: 'auto',
    selfReplying: true,
    parameters: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Name of the agent to hand the task to.' },
        task: {
          type: 'string',
          description: 'The full goal to hand over, as a clear standalone instruction.',
        },
      },
      required: ['agent', 'task'],
    },
    invoke: async (args, ctx) => {
      const chatId = ctx.chatId;
      if (chatId === undefined || !isAgentChatId(chatId)) {
        return 'handoff_task can only be used from within an agent run.';
      }
      const currentTaskId = chatId - AGENT_CHAT_ID_BASE;
      const current = deps.registry.getTask(currentTaskId);
      if (!current) return 'Could not resolve the calling task; handoff aborted.';
      const caller = deps.registry.get(current.agentId);
      if (!caller) return 'Could not resolve the calling agent; handoff aborted.';

      if (current.depth >= MAX_DELEGATION_DEPTH) {
        return `Handoff depth limit (${MAX_DELEGATION_DEPTH}) reached; refusing to chain further.`;
      }

      const targetName = String(args['agent'] ?? '').trim();
      const goal = String(args['task'] ?? '').trim();
      if (!targetName || !goal) return 'Both `agent` and `task` are required.';

      const target = deps.registry.getByName(targetName);
      if (!target) return `No agent named '${targetName}'.`;
      if (target.id === caller.id) {
        return `That's you — handoff_task moves the task to a DIFFERENT agent.`;
      }
      if (caller.delegatableAgents.length > 0 && !caller.delegatableAgents.includes(targetName)) {
        return `Agent '${caller.name}' may not hand off to '${targetName}'.`;
      }

      // The successor can use at most what this task could — carry the ceiling so
      // a handoff never widens a grant (mirrors spawn_agent).
      const ceiling = intersectGrants(caller.toolAllowlist, current.toolAllowlistOverride);

      const successor = deps.registry.enqueue({
        agentId: target.id,
        prompt: goal,
        depth: current.depth + 1,
        executionMode: target.executionMode,
        toolAllowlistOverride: ceiling,
        // Report back wherever the original would have — a transparent handoff.
        ...(current.notifyChatId != null ? { notifyChatId: current.notifyChatId } : {}),
      });
      deps.queue.notify();
      log.info('handed off task', {
        from: caller.name,
        to: targetName,
        fromTask: currentTaskId,
        toTask: successor.id,
      });

      return `Handed this task to ${target.name} as task #${successor.id}. It'll continue and report back.`;
    },
  });
}
