// Main-chat -> agent-queue escalation (the `escalate_to_agent` tool).
//
// The main Telegram/panel chat is deliberately lean: it runs a small, fast model
// and is filtered down to quick conversational tools. Long-horizon work — "plan
// and book a week of meetings", "research X and write me a report", anything
// that needs many steps over many minutes — does not belong on that hot path. So
// instead of letting the chat model grind, it hands the goal to the autonomous
// `operator` agent on the resource-aware queue and tells the user where to watch
// it. The model decides WHEN to escalate (a judgement call) from this tool's
// description; the wiring here just enqueues and points at the Agents tab.
//
// This is the mirror image of spawn_agent: spawn_agent is agent->agent and
// refuses outside an agent run; escalate_to_agent is chat->queue and refuses
// INSIDE one (an agent must delegate with spawn_agent, never re-escalate to a
// sibling operator). start.ts keeps this tool in the chat registry and hides it
// from agents, so the refusal below is defence in depth, not the only guard.

import type { Logger } from '../util/log.js';
import type { ToolRegistry } from './tools.js';
import { isAgentChatId, type AgentRegistry } from './agents.js';
import type { AgentQueue } from './agent-queue.js';

export const ESCALATE_TOOL_NAME = 'escalate_to_agent';

// The seeded autonomous flagship that escalations are routed to. Seeded by
// seedStarterAgents(); if a user has deleted it, the tool says so rather than
// failing opaquely.
const OPERATOR_AGENT_NAME = 'operator';

export interface AgentEscalationDeps {
  tools: ToolRegistry;
  registry: AgentRegistry;
  queue: AgentQueue;
  log: Logger;
}

export function setupAgentEscalation(deps: AgentEscalationDeps): void {
  const log = deps.log.child({ mod: 'agent-escalation' });

  deps.tools.register({
    name: ESCALATE_TOOL_NAME,
    description:
      'Hand a long-horizon, multi-step task to the autonomous operator agent, which plans it, ' +
      'works it over many steps using its own tools and worker agents, and finishes on its own. ' +
      'Use this when the user asks for something that will take many minutes and several steps ' +
      '(deep research, multi-part planning, drafting then revising a long document) rather than a ' +
      'single quick answer or action. Do NOT use it for things you can answer or do directly now. ' +
      'It returns immediately with a task id; the user watches progress in the panel Agents tab.',
    tier: 'auto',
    selfReplying: true,
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description:
            'The goal to hand off, as a clear standalone instruction with all the context the ' +
            'operator needs (it cannot see this chat). State the desired end result.',
        },
      },
      required: ['task'],
    },
    invoke: async (args, ctx) => {
      // An agent must delegate with spawn_agent, not re-escalate. Agents never
      // see this tool (start.ts hides it), so this only fires if that ever
      // regresses.
      if (ctx.chatId !== undefined && isAgentChatId(ctx.chatId)) {
        return 'escalate_to_agent is for the main chat; agents delegate with spawn_agent instead.';
      }

      const task = String(args['task'] ?? '').trim();
      if (!task) return 'A `task` describing the work to hand off is required.';

      const operator = deps.registry.getByName(OPERATOR_AGENT_NAME);
      if (!operator) {
        return `No '${OPERATOR_AGENT_NAME}' agent is configured, so there's nothing to escalate to. Create one in the Agents tab first.`;
      }

      const queued = deps.registry.enqueue({
        agentId: operator.id,
        prompt: task,
        executionMode: operator.executionMode,
      });
      deps.queue.notify();
      log.info('escalated to operator', { task: queued.id });

      return `Handed this to the ${operator.name} as task #${queued.id}. It'll work in the background — watch its progress in the panel's Agents tab.`;
    },
  });
}
