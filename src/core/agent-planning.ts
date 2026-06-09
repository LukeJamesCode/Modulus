// Built-in planning tools for autonomous agents (the plan->act->reflect loop).
//
// Registered as core tools but visible only to agents whose definition has
// mode='autonomous' (the runtime's per-agent tool filter enforces that via
// isPlanningTool, and the main Telegram/panel orchestrator filters them out).
// They are the channel through which the model drives its own loop: it authors a
// todo (update_plan), ticks steps off (complete_step), records findings, saves
// outputs (save_artifact), and declares the goal done (finish). Each tool
// resolves the calling task from the orchestrator chat id — every agent run
// drives the orchestrator against AGENT_CHAT_ID_BASE + taskId — and mutates that
// task row, which is exactly how the loop (agents.ts) reads progress between
// turns and checkpoints it for durable resume.

import type { Logger } from '../util/log.js';
import type { ToolRegistry } from './tools.js';
import {
  isAgentChatId,
  AGENT_CHAT_ID_BASE,
  UPDATE_PLAN_TOOL_NAME,
  COMPLETE_STEP_TOOL_NAME,
  RECORD_FINDING_TOOL_NAME,
  FINISH_TOOL_NAME,
  SAVE_ARTIFACT_TOOL_NAME,
  type AgentPlan,
  type AgentRegistry,
  type PlanStep,
} from './agents.js';

// ---------------------------------------------------------------------------
// Pure plan helpers (no I/O — unit-tested directly)
// ---------------------------------------------------------------------------

interface RawStep {
  id?: string;
  title?: string;
  status?: string;
}

// Coerce the model's `steps` argument into a normalised plan. Accepts an array
// of plain strings or {id?,title,status?} objects. New steps get a stable id
// (s1, s2, ...); a step whose id matches one in the previous plan keeps that
// step's status unless the model explicitly sets a new one — so re-authoring the
// plan mid-run never silently un-completes finished work.
export function mergePlan(raw: unknown, prev: AgentPlan | null): AgentPlan {
  const arr = Array.isArray(raw) ? raw : [];
  const prevById = new Map<string, PlanStep>((prev?.steps ?? []).map((s) => [s.id, s]));
  const prevByTitle = new Map<string, PlanStep>((prev?.steps ?? []).map((s) => [s.title.toLowerCase(), s]));
  const steps: PlanStep[] = [];
  let n = 0;
  for (const entry of arr) {
    n += 1;
    const obj: RawStep = typeof entry === 'string' ? { title: entry } : ((entry as RawStep) ?? {});
    const title = String(obj.title ?? '').trim();
    if (!title) continue;
    
    let id = String(obj.id ?? '').trim();
    const oldStep = (id ? prevById.get(id) : undefined) ?? prevByTitle.get(title.toLowerCase());
    
    if (!id) {
      if (oldStep) {
        id = oldStep.id;
      } else {
        let i = n;
        while (prevById.has(`s${i}`) || steps.some((s) => s.id === `s${i}`)) i++;
        id = `s${i}`;
      }
    }

    const explicit =
      obj.status === 'pending' || obj.status === 'active' || obj.status === 'done'
        ? obj.status
        : undefined;
    const status: PlanStep['status'] = explicit ?? oldStep?.status ?? 'pending';
    steps.push({ id, title, status });
  }
  return { steps };
}

// The step the loop should work next: the first 'active', else the first
// 'pending'. undefined when every step is done (or the plan is empty).
export function firstUnfinished(plan: AgentPlan | null): PlanStep | undefined {
  if (!plan) return undefined;
  return (
    plan.steps.find((s) => s.status === 'active') ?? plan.steps.find((s) => s.status === 'pending')
  );
}

// Mark a step done. With an id, that step; otherwise the first unfinished one.
// Returns the mutated plan and the step that was completed (if any).
export function markDone(
  plan: AgentPlan | null,
  id?: string,
): { plan: AgentPlan; step: PlanStep | undefined } {
  const base: AgentPlan = plan ? { steps: plan.steps.map((s) => ({ ...s })) } : { steps: [] };
  const target = id ? base.steps.find((s) => s.id === id) : firstUnfinished(base);
  if (target) target.status = 'done';
  return { plan: base, step: target };
}

// True when a non-empty plan has every step done.
export function allStepsDone(plan: AgentPlan | null): boolean {
  return !!plan && plan.steps.length > 0 && plan.steps.every((s) => s.status === 'done');
}

// Mark the step the loop is about to work as 'active' so the run view shows it
// in progress (spinner) before it ticks to 'done'. The first not-done step
// becomes active; every other not-done step is forced back to 'pending' so at
// most one step is ever active. Done steps are untouched. Returns a new plan, or
// the same reference when nothing changes (empty/all-done) so callers can skip a
// redundant write. The model can't set 'active' itself (update_plan only takes
// titles), so without this steps would jump pending->done with no visible cursor.
export function markActive(plan: AgentPlan | null): AgentPlan | null {
  if (!plan || plan.steps.length === 0) return plan;
  let activated = false;
  let changed = false;
  const steps: PlanStep[] = plan.steps.map((s) => {
    if (s.status === 'done') return s;
    const next: PlanStep['status'] = activated ? 'pending' : 'active';
    if (!activated) activated = true;
    if (next !== s.status) changed = true;
    return next === s.status ? s : { ...s, status: next };
  });
  return changed ? { steps } : plan;
}

// A compact one-line-per-step render for tool replies / prompts.
export function renderPlan(plan: AgentPlan | null): string {
  if (!plan || plan.steps.length === 0) return '(no plan yet)';
  const mark = { done: '[x]', active: '[~]', pending: '[ ]' };
  return plan.steps.map((s) => `${mark[s.status]} ${s.title}`).join('\n');
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export interface AgentPlanningDeps {
  tools: ToolRegistry;
  registry: AgentRegistry;
  log: Logger;
}

export function setupAgentPlanning(deps: AgentPlanningDeps): void {
  const log = deps.log.child({ mod: 'agent-planning' });

  // Resolve the running task from the tool context, or return a string the model
  // sees explaining why the call was a no-op.
  const resolveTaskId = (chatId: number | undefined): { taskId: number } | { err: string } => {
    if (chatId === undefined || !isAgentChatId(chatId)) {
      return { err: 'This tool can only be used from within an autonomous agent run.' };
    }
    const taskId = chatId - AGENT_CHAT_ID_BASE;
    if (!deps.registry.getTask(taskId)) {
      return { err: 'Could not resolve the calling task.' };
    }
    return { taskId };
  };

  deps.tools.register({
    name: UPDATE_PLAN_TOOL_NAME,
    description:
      'Create or revise your step-by-step plan for the task. Pass the full ordered list of steps ' +
      'each time (it replaces the current plan). Re-authoring keeps already-completed steps done. ' +
      'Call this first, and again whenever the plan should change.',
    tier: 'auto',
    parameters: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          description: 'The ordered steps. Each is a short imperative title.',
          items: {
            type: 'object',
            properties: { title: { type: 'string', description: 'Short imperative step.' } },
            required: ['title'],
          },
        },
      },
      required: ['steps'],
    },
    invoke: async (args, ctx) => {
      const r = resolveTaskId(ctx.chatId);
      if ('err' in r) return r.err;
      const task = deps.registry.getTask(r.taskId)!;
      const plan = mergePlan(args['steps'], task.plan);
      if (plan.steps.length === 0) return 'A plan needs at least one step.';
      deps.registry.updateTask(r.taskId, { plan });
      log.info('plan updated', { taskId: r.taskId, steps: plan.steps.length });
      return `Plan set (${plan.steps.length} steps):\n${renderPlan(plan)}`;
    },
  });

  deps.tools.register({
    name: COMPLETE_STEP_TOOL_NAME,
    description:
      'Mark a plan step finished once you have actually done it. Omit `id` to complete the current ' +
      'step. Do this as you go so progress is tracked and the run can stop when the plan is done.',
    tier: 'auto',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Step id to complete; omit for the current step.' },
        result: { type: 'string', description: 'Optional one-line outcome of the step.' },
      },
    },
    invoke: async (args, ctx) => {
      const r = resolveTaskId(ctx.chatId);
      if ('err' in r) return r.err;
      const task = deps.registry.getTask(r.taskId)!;
      const id = String(args['id'] ?? '').trim() || undefined;
      const { plan, step } = markDone(task.plan, id);
      if (!step) return 'No matching step to complete.';
      deps.registry.updateTask(r.taskId, { plan });
      log.info('step completed', { taskId: r.taskId, step: step.id });
      return `Completed: ${step.title}\nRemaining plan:\n${renderPlan(plan)}`;
    },
  });

  deps.tools.register({
    name: RECORD_FINDING_TOOL_NAME,
    description:
      'Record an important fact or intermediate result so it is retained for the final answer. ' +
      'Use this for things you discover that you must not forget.',
    tier: 'auto',
    parameters: {
      type: 'object',
      properties: { note: { type: 'string', description: 'The fact or result to remember.' } },
      required: ['note'],
    },
    invoke: async (args, ctx) => {
      const r = resolveTaskId(ctx.chatId);
      if ('err' in r) return r.err;
      const note = String(args['note'] ?? '').trim();
      if (!note) return 'Nothing to record.';
      deps.registry.addArtifact({ taskId: r.taskId, name: 'finding', content: note });
      return 'Recorded.';
    },
  });

  deps.tools.register({
    name: SAVE_ARTIFACT_TOOL_NAME,
    description:
      'Save a named output (a document, draft, list, code, etc.) the user can keep. ' +
      'Use this for deliverables rather than burying them in chat.',
    tier: 'auto',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'A short file-like name, e.g. "summary.md".' },
        content: { type: 'string', description: 'The artifact body.' },
        mime: { type: 'string', description: 'Optional MIME type; defaults to text/plain.' },
      },
      required: ['name', 'content'],
    },
    invoke: async (args, ctx) => {
      const r = resolveTaskId(ctx.chatId);
      if ('err' in r) return r.err;
      const name = String(args['name'] ?? '').trim();
      const content = String(args['content'] ?? '');
      if (!name) return 'An artifact needs a name.';
      const mimeArg = String(args['mime'] ?? '').trim();
      deps.registry.addArtifact({
        taskId: r.taskId,
        name,
        content,
        ...(mimeArg ? { mime: mimeArg } : {}),
      });
      log.info('artifact saved', { taskId: r.taskId, name });
      return `Saved artifact '${name}' (${content.length} chars).`;
    },
  });

  deps.tools.register({
    name: FINISH_TOOL_NAME,
    description:
      'Declare the whole task complete and deliver your final answer. Call this exactly once, when ' +
      'the goal is met. The summary you pass is returned to the user as the result.',
    tier: 'auto',
    // The summary IS the final answer; ship it verbatim and end the turn.
    selfReplying: true,
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'The final answer / summary for the user.' },
      },
      required: ['summary'],
    },
    invoke: async (args, ctx) => {
      const r = resolveTaskId(ctx.chatId);
      if ('err' in r) return r.err;
      const summary = String(args['summary'] ?? '').trim() || 'Task complete.';
      // Writing result is the loop's stop signal for an autonomous run; also mark
      // the plan fully done so the UI reads 100%.
      const task = deps.registry.getTask(r.taskId)!;
      const plan: AgentPlan | null = task.plan
        ? { steps: task.plan.steps.map((s) => ({ ...s, status: 'done' as const })) }
        : null;
      deps.registry.updateTask(r.taskId, { result: summary, ...(plan ? { plan } : {}) });
      log.info('agent declared finish', { taskId: r.taskId });
      return summary;
    },
  });
}
