// Natural-language scheduling front door. One shared creation path feeds both
// the model-facing `create_schedule` tool and the Telegram /remind · /every
// commands, so a reminder behaves identically however it was asked for.
//
// A reminder with no agent is notify-only (the sweep nudges the chat). A
// reminder with an agent dispatches that agent on the cron/at, pinging the chat
// when the task finishes — and inherits the agent's tool gating, so a
// confirm/owner-tier tool in that unattended run still parks for approval.

import type { Logger } from '../util/log.js';
import type { LLM } from './llm.js';
import type { AgentRegistry } from './agents.js';
import type { ToolHandler, ToolRegistry } from './tools.js';
import type { AgentSchedule, AgentScheduleStore } from './agent-schedules.js';
import { parseSchedule, describeSpec, type ScheduleSpec } from './schedule-parse.js';

export interface SchedulingDeps {
  store: AgentScheduleStore;
  registry: AgentRegistry;
  log: Logger;
  // Default IANA zone wall-clock phrases resolve against (host zone).
  timeZone: string;
  // Optional fallback model for novel phrasings.
  llm?: LLM;
  now?: () => Date;
}

export interface CreateScheduleInput {
  // Chat to notify (and to own a notify-only reminder). Omit for a pure agent
  // schedule created outside a chat context.
  chatId?: number | null;
  // Name of an agent to run on the schedule, or omit for a notify-only reminder.
  agentName?: string;
  when: string;
  what: string;
  // /every and /remind hint the recurrence so a user can drop the leading
  // "every" ("/every weekday at 8" → "every weekday at 8").
  recurringHint?: boolean;
}

// A spec that actually resolved (no error) — what a successful create carries.
export type ResolvedScheduleSpec = Exclude<ScheduleSpec, { error: string }>;

export type CreateScheduleResult =
  | { schedule: AgentSchedule; spec: ResolvedScheduleSpec }
  | { error: string };

// Prepend "every " when a recurring command's phrase omits it, so "weekday at
// 8" parses as a recurrence rather than failing.
function coerceRecurring(when: string): string {
  return /^(every|each|daily|hourly|weekly|monthly|on\s+the\b)/i.test(when.trim())
    ? when.trim()
    : `every ${when.trim()}`;
}

export async function createScheduleFromText(
  deps: SchedulingDeps,
  input: CreateScheduleInput,
): Promise<CreateScheduleResult> {
  const what = String(input.what ?? '').trim();
  if (!what) return { error: 'Tell me what to remind you about.' };
  const whenText = input.recurringHint
    ? coerceRecurring(input.when)
    : String(input.when ?? '').trim();
  if (!whenText) return { error: 'Say when — e.g. "in 20 minutes" or "every weekday at 8am".' };

  let agentId: number | undefined;
  if (input.agentName?.trim()) {
    const agent = deps.registry.getByName(input.agentName.trim());
    if (!agent) return { error: `No agent named '${input.agentName.trim()}'.` };
    agentId = agent.id;
  }

  const chatId = input.chatId ?? null;
  if (agentId === undefined && chatId == null) {
    return { error: 'A reminder needs a chat to notify (or name an agent to run).' };
  }

  const spec = await parseSchedule(whenText, {
    now: deps.now ? deps.now() : new Date(),
    timeZone: deps.timeZone,
    ...(deps.llm ? { llm: deps.llm } : {}),
    log: deps.log,
  });
  if ('error' in spec) return { error: spec.error };

  try {
    const schedule = deps.store.create({
      agentIds: agentId === undefined ? [] : [agentId],
      prompt: what,
      notifyChatId: chatId,
      ...(spec.kind === 'once'
        ? { nextRunAt: spec.at, recurrence: 'once' as const }
        : { cron: spec.cron, timeZone: spec.timeZone }),
    });
    return { schedule, spec };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

// Human one-liner for a stored schedule, for /schedules lists and confirmations.
export function describeSchedule(s: AgentSchedule, fallbackTz: string): string {
  const tz = s.timeZone ?? fallbackTz;
  const spec: ScheduleSpec = s.cron
    ? { kind: 'recurring', cron: s.cron, timeZone: tz }
    : { kind: 'once', at: s.nextRunAt };
  return describeSpec(spec, tz);
}

// One-line reply after creating a schedule.
export function formatCreatedReply(
  result: { schedule: AgentSchedule; spec: ResolvedScheduleSpec },
  fallbackTz: string,
  agentName?: string,
): string {
  const { schedule, spec } = result;
  const when = describeSpec(spec, schedule.timeZone ?? fallbackTz);
  const verb = spec.kind === 'recurring' ? 'Repeating' : 'Scheduled';
  const who = agentName ? ` ${agentName} will` : '';
  return `✅ ${verb} #${schedule.id} —${who} ${when}: ${schedule.prompt}`;
}

const CREATE_SCHEDULE_INTENT =
  '\\b(remind me|reminder|every ?day|each (day|morning|week|month)|every (week|month|hour|morning|evening|night|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekday|weekend)|daily|hourly|weekly|monthly|wake me|nudge me (every|each|at)|schedule .* (every|each|daily|at|tomorrow|tonight))\\b';

export const CREATE_SCHEDULE_TOOL_NAME = 'create_schedule';

// Register the model-facing create_schedule tool. Auto-tier: creating a
// reminder/schedule is low-risk and can't itself reach external systems —
// an agent it later dispatches still runs under that agent's gating.
export function setupScheduleTools(deps: SchedulingDeps & { tools: ToolRegistry }): void {
  const tool: ToolHandler = {
    name: CREATE_SCHEDULE_TOOL_NAME,
    intentPattern: CREATE_SCHEDULE_INTENT,
    description:
      'Create a one-time OR repeating reminder/scheduled task from a natural-language time. ' +
      "Use for 'remind me every weekday at 8 to take my pills', 'in 2 hours ping me about the oven', " +
      "'every Monday at 9 have <agent> summarise my week'. The `when` is plain English (this tool parses it) — " +
      'do NOT pre-convert it to ISO or cron. Set `agent` only to have a specific agent run on the schedule; ' +
      'otherwise it just messages the user.',
    parameters: {
      type: 'object',
      required: ['when', 'what'],
      properties: {
        when: {
          type: 'string',
          description:
            'Natural-language time. One-time ("in 30 minutes", "tomorrow at 9", "tonight") or ' +
            'repeating ("every weekday at 8am", "every 2 hours", "monthly on the 1st").',
        },
        what: {
          type: 'string',
          description: 'The reminder message, or the task prompt when an agent is set.',
        },
        agent: {
          type: 'string',
          description: 'Optional agent name to run on the schedule. Omit for a plain reminder.',
        },
      },
    },
    tier: 'auto',
    selfReplying: true,
    invoke: async (args, ctx) => {
      const result = await createScheduleFromText(deps, {
        chatId: ctx.chatId ?? null,
        when: String(args['when'] ?? ''),
        what: String(args['what'] ?? ''),
        ...(args['agent'] ? { agentName: String(args['agent']) } : {}),
      });
      if ('error' in result) return `Couldn't schedule that: ${result.error}`;
      return formatCreatedReply(
        result,
        deps.timeZone,
        args['agent'] ? String(args['agent']) : undefined,
      );
    },
  };
  deps.tools.register(tool);
}
