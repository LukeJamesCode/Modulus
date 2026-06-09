// The spawn_agent delegation tool (supervisor -> worker).
//
// Registered as a core tool but visible only to agents whose definition has
// canDelegate (the runtime's per-agent tool filter enforces that, and the main
// Telegram/panel orchestrator filters it out entirely). When a supervisor's
// turn calls it, we resolve the calling task from the tool context's chat id
// (every agent run drives the orchestrator against AGENT_CHAT_ID_BASE + taskId),
// enforce the delegation grant, and run or enqueue a child task.
//
// Security invariants:
//   - canDelegate must be set on the calling agent.
//   - the target must be in the caller's delegatableAgents ([] = any).
//   - delegation depth is capped (MAX_DELEGATION_DEPTH).
//   - the child's tool grant is intersected with the caller's effective grant,
//     so a worker can never reach a tool the supervisor itself couldn't use.
//
// `await` mode runs the child inline (the supervisor isn't using the model
// during tool execution, so there's no contention and no risk of the heavy
// slot deadlocking on itself) and returns the worker's reply as the tool
// result. `async` mode enqueues the child on the resource-aware queue and
// returns its id immediately.

import type { Logger } from '../util/log.js';
import type { LLM } from './llm.js';
import type { ToolRegistry } from './tools.js';
import type { AgentQueue } from './agent-queue.js';
import {
  isAgentChatId,
  intersectGrants,
  AGENT_CHAT_ID_BASE,
  MAX_DELEGATION_DEPTH,
  SPAWN_AGENT_TOOL_NAME,
  SPAWN_AGENTS_TOOL_NAME,
  type AgentExecutionMode,
  type AgentRegistry,
  type AgentRuntime,
} from './agents.js';
import { parseSpawnAgentsArgs } from './agent-delegation-args.js';

// Upper bound on a single spawn_agents fan-out. A cap on the NUMBER of subtasks
// (independent of how many run at once): it stops a confused supervisor from
// enqueuing dozens of children in one call. Eight is comfortably more than any
// sane decomposition while staying cheap to run even one-at-a-time on a Pi.
export const MAX_SPAWN_AGENTS = 8;

export interface AgentDelegationDeps {
  tools: ToolRegistry;
  // Used to detect whether a delegation target occupies the heavy model slot —
  // spawn_agents refuses heavy targets (see below).
  llm: LLM;
  registry: AgentRegistry;
  runtime: AgentRuntime;
  queue: AgentQueue;
  log: Logger;
  // Max worker agents spawn_agents runs concurrently. Bounds how many small
  // models load at once; defaults to 1 (Pi-safe). Callers pass the tier's
  // tiny-worker budget.
  maxParallel?: number;
}

export function setupAgentDelegation(deps: AgentDelegationDeps): void {
  const log = deps.log.child({ mod: 'agent-delegation' });

  deps.tools.register({
    name: SPAWN_AGENT_TOOL_NAME,
    description:
      'Delegate a subtask to another agent and (by default) wait for its result. ' +
      'Use this to break a hard task into smaller pieces handled by specialised agents.',
    tier: 'auto',
    parameters: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Name of the agent to delegate to.' },
        task: { type: 'string', description: 'The subtask, as a clear instruction.' },
        mode: {
          type: 'string',
          enum: ['await', 'async'],
          description:
            "'await' (default) runs the worker now and returns its answer; " +
            "'async' starts it in the background and returns a task id.",
        },
      },
      required: ['agent', 'task'],
    },
    invoke: async (args, ctx) => {
      const chatId = ctx.chatId;
      if (chatId === undefined || !isAgentChatId(chatId)) {
        return 'spawn_agent can only be used from within an agent run.';
      }
      const parentTaskId = chatId - AGENT_CHAT_ID_BASE;
      const parentTask = deps.registry.getTask(parentTaskId);
      if (!parentTask) return 'Could not resolve the calling task; delegation aborted.';
      const parentAgent = deps.registry.get(parentTask.agentId);
      if (!parentAgent) return 'Could not resolve the calling agent; delegation aborted.';

      if (!parentAgent.canDelegate) {
        return `Agent '${parentAgent.name}' is not permitted to delegate.`;
      }
      if (parentTask.depth >= MAX_DELEGATION_DEPTH) {
        return `Delegation depth limit (${MAX_DELEGATION_DEPTH}) reached; refusing to spawn deeper.`;
      }

      const targetName = String(args['agent'] ?? '').trim();
      const subtask = String(args['task'] ?? '').trim();
      if (!targetName || !subtask) return 'Both `agent` and `task` are required.';

      const target = deps.registry.getByName(targetName);
      if (!target) return `No agent named '${targetName}'.`;
      // [] means "any agent"; a non-empty list is an explicit allowlist.
      if (
        parentAgent.delegatableAgents.length > 0 &&
        !parentAgent.delegatableAgents.includes(targetName)
      ) {
        return `Agent '${parentAgent.name}' may not delegate to '${targetName}'.`;
      }

      // The worker can use at most what the supervisor itself could — its own
      // effective grant (its allowlist intersected with any ceiling it inherited).
      const parentEffectiveGrant = intersectGrants(
        parentAgent.toolAllowlist,
        parentTask.toolAllowlistOverride,
      );

      const mode = args['mode'] === 'async' ? 'async' : 'await';
      const child = deps.registry.enqueue({
        agentId: target.id,
        prompt: subtask,
        parentId: parentTask.id,
        depth: parentTask.depth + 1,
        executionMode: target.executionMode,
        toolAllowlistOverride: parentEffectiveGrant,
      });
      log.info('delegated subtask', {
        from: parentAgent.name,
        to: targetName,
        mode,
        childTask: child.id,
        depth: child.depth,
      });

      if (mode === 'async') {
        // Hand it to the resource-aware queue and return immediately.
        deps.queue.notify();
        return `Started '${targetName}' on task #${child.id} in the background.`;
      }

      // Inline run: the supervisor is paused in tool execution (not generating),
      // so running the worker now doesn't contend for the model.
      const result = await deps.runtime.runTask(child.id);
      if (!result.ok) {
        return `Sub-agent '${targetName}' failed: ${result.error ?? 'unknown error'}`;
      }
      return result.text || `Sub-agent '${targetName}' finished with no output.`;
    },
  });

  deps.tools.register({
    name: SPAWN_AGENTS_TOOL_NAME,
    description:
      'Delegate several subtasks to lightweight worker agents IN PARALLEL and wait for all of them. ' +
      'Use this to fan one task out across workers (e.g. gather calendar, tasks, and weather at once), ' +
      'then synthesise their combined results yourself. Targets must be lightweight (non-reasoning) ' +
      'agents; for a single heavy agent use spawn_agent instead.',
    tier: 'auto',
    parameters: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          description: 'The subtasks to run in parallel.',
          items: {
            type: 'object',
            properties: {
              agent: { type: 'string', description: 'Name of the worker agent.' },
              task: { type: 'string', description: 'The subtask, as a clear instruction.' },
            },
            required: ['agent', 'task'],
          },
        },
      },
      required: ['tasks'],
    },
    invoke: async (args, ctx) => {
      const chatId = ctx.chatId;
      if (chatId === undefined || !isAgentChatId(chatId)) {
        return 'spawn_agents can only be used from within an agent run.';
      }
      const parentTaskId = chatId - AGENT_CHAT_ID_BASE;
      const parentTask = deps.registry.getTask(parentTaskId);
      if (!parentTask) return 'Could not resolve the calling task; delegation aborted.';
      const parentAgent = deps.registry.get(parentTask.agentId);
      if (!parentAgent) return 'Could not resolve the calling agent; delegation aborted.';

      if (!parentAgent.canDelegate) {
        return `Agent '${parentAgent.name}' is not permitted to delegate.`;
      }
      if (parentTask.depth >= MAX_DELEGATION_DEPTH) {
        return `Delegation depth limit (${MAX_DELEGATION_DEPTH}) reached; refusing to spawn deeper.`;
      }

      const parsed = parseSpawnAgentsArgs(args, MAX_SPAWN_AGENTS);
      if (!parsed.ok) return parsed.error;

      // Resolve and authorise the WHOLE batch before running anything, so the
      // supervisor gets one clear rejection rather than a half-completed
      // fan-out. Three gates per target, mirroring spawn_agent: the agent must
      // exist, be within the caller's delegatable set, and — unique to the
      // parallel path — must NOT occupy the heavy model slot. A heavy target
      // would deadlock: this supervisor already holds a slot while paused in
      // tool execution, and Ollama keeps only one heavy model resident, so a
      // parallel heavy fan-out can never get a slot to run.
      const profiles = deps.llm.listProfiles();
      const resolved: Array<{
        name: string;
        agentId: number;
        subtask: string;
        mode: AgentExecutionMode;
      }> = [];
      for (const r of parsed.tasks) {
        const target = deps.registry.getByName(r.agent);
        if (!target) return `No agent named '${r.agent}'.`;
        if (
          parentAgent.delegatableAgents.length > 0 &&
          !parentAgent.delegatableAgents.includes(r.agent)
        ) {
          return `Agent '${parentAgent.name}' may not delegate to '${r.agent}'.`;
        }
        if (profiles[target.profile]?.heavy) {
          return (
            `Agent '${r.agent}' uses a heavy reasoning model; spawn_agents only fans out lightweight ` +
            `workers. Delegate to it with spawn_agent instead.`
          );
        }
        resolved.push({
          name: r.agent,
          agentId: target.id,
          subtask: r.task,
          mode: target.executionMode,
        });
      }

      // The worker can use at most what the supervisor itself could.
      const parentEffectiveGrant = intersectGrants(
        parentAgent.toolAllowlist,
        parentTask.toolAllowlistOverride,
      );

      // Bounded inline fan-out. Children run inline via runTask (NOT enqueued on
      // the resource queue) for the same reason spawn_agent's await mode does:
      // the supervisor is paused in tool execution, so there's no model
      // contention, and queueing would deadlock against the slot the supervisor
      // still holds. `maxParallel` bounds how many small models load at once.
      // Each child is enqueued and immediately run, and runTask flips the row to
      // 'running' synchronously before its first await, so the DB poller can
      // never double-run it.
      const limit = Math.max(1, deps.maxParallel ?? 1);
      const results = new Array<string>(resolved.length);
      const startedChildIds: number[] = [];
      let aborted = false;
      const onAbort = (): void => {
        aborted = true;
        for (const id of startedChildIds) deps.runtime.cancelTask(id);
      };
      if (ctx.signal) {
        if (ctx.signal.aborted) onAbort();
        else ctx.signal.addEventListener('abort', onAbort, { once: true });
      }

      let next = 0;
      const worker = async (): Promise<void> => {
        for (;;) {
          if (aborted) return;
          const i = next++;
          if (i >= resolved.length) return;
          const r = resolved[i]!;
          const child = deps.registry.enqueue({
            agentId: r.agentId,
            prompt: r.subtask,
            parentId: parentTask.id,
            depth: parentTask.depth + 1,
            executionMode: r.mode,
            toolAllowlistOverride: parentEffectiveGrant,
          });
          startedChildIds.push(child.id);
          deps.log.info('fan-out subtask', {
            from: parentAgent.name,
            to: r.name,
            childTask: child.id,
            depth: child.depth,
          });
          const res = await deps.runtime.runTask(child.id);
          results[i] = res.ok
            ? res.text || `(${r.name} finished with no output)`
            : `(${r.name} failed: ${res.error ?? 'unknown error'})`;
        }
      };

      try {
        await Promise.all(Array.from({ length: Math.min(limit, resolved.length) }, () => worker()));
      } finally {
        ctx.signal?.removeEventListener('abort', onAbort);
      }
      if (aborted) return 'Parallel delegation cancelled.';

      // Label each result by agent + position so the supervisor can attribute
      // outputs back to the subtask it asked for.
      return resolved
        .map((r, i) => `## ${r.name} (task ${i + 1})\n${results[i] ?? '(no result)'}`)
        .join('\n\n');
    },
  });
}
