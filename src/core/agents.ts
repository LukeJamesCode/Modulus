// Multi-agent engine. An "agent" is a named persona: a saved bundle of
// orchestrator options (system prompt, model profile, tool allowlist, tool-
// round cap) plus an execution policy and an optional delegation grant.
//
// Running an agent reuses the normal orchestrator pipeline — the persona's
// options ARE an OrchestratorOptions, and a per-agent filtered tool registry
// scopes which tools the model can see. Each run is driven against a reserved
// "virtual" chat id so its transcript lands in conversations/messages exactly
// like a Telegram turn, inheriting every guard (hallucination scrubbing,
// per-turn schema gate, tool timeouts) for free.
//
// This module owns the agent definitions + task rows (AgentRegistry) and the
// headless runner (AgentRuntime). The resource-aware queue that decides WHEN
// to run a task is a separate concern (agent-queue.ts).

import type { DB } from '../storage/db.js';
import type { Logger } from '../util/log.js';
import type { LLM, ProfileName, ThinkMode } from './llm.js';
import type { ToolHandler, ToolRegistry } from './tools.js';
import { createOrchestrator, type Orchestrator, type ReplyChunk } from './orchestrator.js';
import { allStepsDone, markActive, renderPlan } from './agent-planning.js';
import { loadImageAttachmentsBase64 } from './agent-attachments.js';

// Virtual chat ids for agent runs live in a reserved band well above any real
// Telegram user id (currently < ~8e9 and growing slowly) and far below
// Number.MAX_SAFE_INTEGER (~9.0e15). virtual_chat_id = AGENT_CHAT_ID_BASE +
// task.id keeps every run on its own conversation without colliding with chat
// surfaces. The frontend history view filters this band out so agent
// transcripts don't masquerade as user chats.
export const AGENT_CHAT_ID_BASE = 7_000_000_000_000;

export function isAgentChatId(chatId: number): boolean {
  return chatId >= AGENT_CHAT_ID_BASE;
}

// Per-agent direct-message ("DM") virtual ids live in their own band above the
// task band: dm_chat_id = AGENT_DM_CHAT_ID_BASE + agent.id. A DM is ONE
// persistent conversation per agent (the panel's Slack-style chat), unlike
// task ids which get a fresh conversation per run. The band still satisfies
// isAgentChatId so DM transcripts stay out of user chat surfaces, but the
// confirm router must branch on isAgentDmChatId FIRST: a DM turn is attended
// (a human is watching the panel stream), so confirms render inline there
// instead of parking in the unattended approval queue.
export const AGENT_DM_CHAT_ID_BASE = 8_000_000_000_000;

export function agentDmChatId(agentId: number): number {
  return AGENT_DM_CHAT_ID_BASE + agentId;
}

export function isAgentDmChatId(chatId: number): boolean {
  return chatId >= AGENT_DM_CHAT_ID_BASE;
}

// Name of the built-in delegation tool. Exposed only to agents whose
// definition has canDelegate; the main (Telegram/panel) orchestrator filters
// it out entirely. Registered by setupAgentDelegation (agent-delegation.ts).
export const SPAWN_AGENT_TOOL_NAME = 'spawn_agent';

// Name of the built-in parallel fan-out/join tool. Like spawn_agent it's
// visible only to agents whose definition has canDelegate, and filtered out of
// the main (Telegram/panel) orchestrator. Dispatches several lightweight
// workers at once and waits for all of them. Registered by
// setupAgentDelegation (agent-delegation.ts).
export const SPAWN_AGENTS_TOOL_NAME = 'spawn_agents';

// Name of the built-in approval tool. A 'confirm'-tier tool any agent may call
// to pause and ask the human to sign off on a risky step it identified itself.
// Always visible to agents (independent of their tool allowlist); filtered out
// of the main chat orchestrator. Registered by setupAgentApprovals
// (agent-approvals.ts).
export const REQUEST_APPROVAL_TOOL_NAME = 'request_approval';

// Built-in planning tools, visible ONLY to autonomous agents (filtered out of
// single-mode agents and the main chat orchestrator). Registered by
// setupAgentPlanning (agent-planning.ts). They are how the model drives its own
// plan->act->reflect loop: author/revise a todo, tick steps off, record
// findings, save outputs, and declare the goal done.
export const UPDATE_PLAN_TOOL_NAME = 'update_plan';
export const COMPLETE_STEP_TOOL_NAME = 'complete_step';
export const RECORD_FINDING_TOOL_NAME = 'record_finding';
export const FINISH_TOOL_NAME = 'finish';
export const SAVE_ARTIFACT_TOOL_NAME = 'save_artifact';

const PLANNING_TOOL_NAMES = new Set<string>([
  UPDATE_PLAN_TOOL_NAME,
  COMPLETE_STEP_TOOL_NAME,
  RECORD_FINDING_TOOL_NAME,
  FINISH_TOOL_NAME,
  SAVE_ARTIFACT_TOOL_NAME,
]);

export function isPlanningTool(name: string): boolean {
  return PLANNING_TOOL_NAMES.has(name);
}

// Maximum delegation depth (supervisor -> worker -> ...). A top-level task is
// depth 0; spawn_agent refuses once a child would exceed this, so a buggy
// persona can't recurse without bound.
export const MAX_DELEGATION_DEPTH = 3;
export const AGENT_TASK_CANCELLED_MESSAGE = 'Agent task cancelled by user.';

// Autonomous-run budget defaults (used when an agent leaves a ceiling null). A
// "round" is one orchestrator turn of the loop; the wall-clock counts from the
// task's original start so a resumed run keeps its overall deadline.
export const DEFAULT_MAX_TOTAL_ROUNDS = 30;
export const DEFAULT_MAX_WALL_CLOCK_MS = 30 * 60_000;
// Consecutive no-progress turns (no completed step, no finish) before the loop
// gives up and finalises — guards against a model that stalls without finishing,
// including one that keeps re-wording its plan without ever completing a step.
export const AUTONOMOUS_STALL_LIMIT = 5;
// Min gap between live_text writes during a turn. The panel polls the DB ~1/s, so
// writing reasoning faster than this just burns Pi disk I/O for no visible gain.
export const LIVE_TEXT_THROTTLE_MS = 800;

// Loop discipline appended to an autonomous agent's system prompt. The loop
// itself (createAgentRuntime) is deterministic code; this just teaches the model
// the contract for the planning tools it is given.
export const AUTONOMOUS_PREAMBLE = [
  'You are an AUTONOMOUS agent. You work the task across many turns until it is fully done — you',
  'are not answering a single question. Follow this loop:',
  '1. First, call update_plan with a short, ordered list of concrete steps.',
  '2. Each turn, do the next unfinished step with your tools, then call complete_step.',
  '3. Use record_finding to keep facts you must not forget, and save_artifact for deliverables.',
  '4. Revise the plan with update_plan whenever reality differs from it.',
  '5. When the whole goal is met, call finish exactly once with the final answer for the user.',
  'Do not ask the user questions — make reasonable assumptions and keep going. Keep each turn focused.',
].join('\n');

// Intersect two tool grants. null means "all tools". The result never grants
// more than either input (fail-safe): the AND of two ceilings. For two
// explicit lists it's a string-set intersection — conservative if a module
// name and one of its tool names are split across the two, which only ever
// over-restricts.
export function intersectGrants(a: string[] | null, b: string[] | null): string[] | null {
  if (a === null) return b === null ? null : [...b];
  if (b === null) return [...a];
  const bset = new Set(b);
  return a.filter((x) => bset.has(x));
}

export type AgentExecutionMode = 'sequential' | 'parallel';
export type AgentTaskStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled' | 'paused';

// 'single' = today's bounded one-turn run. 'autonomous' = the plan->act->reflect
// loop that works a persisted todo until done or a budget trips (agents.ts loop).
export type AgentMode = 'single' | 'autonomous';

export type PlanStepStatus = 'pending' | 'active' | 'done';
export interface PlanStep {
  id: string;
  title: string;
  status: PlanStepStatus;
}
// The agent-authored todo an autonomous run works through. Persisted as
// agent_tasks.plan_json and checkpointed after every step for durable resume.
export interface AgentPlan {
  steps: PlanStep[];
}

// A saved output of an autonomous run (agent_artifacts row).
export interface AgentArtifact {
  id: number;
  taskId: number;
  name: string;
  mime: string;
  content: string | null;
  createdAt: number;
}

// A dropped-in INPUT for a task (agent_task_attachments row). Bytes live on disk
// under the per-task attachment dir; `path` is relative to it. 'image' goes to a
// multimodal model as base64; 'file'/'pdf' (the latter as extracted text) land
// in the dir read_file/list_dir is pinned to.
export type AttachmentKind = 'file' | 'image' | 'pdf';
export interface AgentAttachment {
  id: number;
  taskId: number;
  kind: AttachmentKind;
  name: string;
  path: string;
  mime: string;
  bytes: number;
  createdAt: number;
}

export interface AgentDefinition {
  id: number;
  name: string;
  role: string;
  systemPrompt: string;
  // null = every registered tool; otherwise a list of module names and/or
  // specific tool names the agent may call.
  toolAllowlist: string[] | null;
  profile: ProfileName;
  // Whether this agent's model reasons. 'auto' = per-model default.
  thinkMode: ThinkMode;
  maxToolRounds: number;
  // null => orchestrator default.
  budgetTokens: number | null;
  executionMode: AgentExecutionMode;
  maxConcurrency: number;
  canDelegate: boolean;
  // Agent names this agent may spawn; [] with canDelegate means "any". Ignored
  // when canDelegate is false.
  delegatableAgents: string[];
  // 'single' bounded run vs 'autonomous' plan->act->reflect loop.
  mode: AgentMode;
  // Autonomous-run budget ceilings; null => engine default.
  maxWallClockMs: number | null;
  maxTotalRounds: number | null;
  // Provenance: null = user-created; 'module:<name>' = provided by that module's
  // manifest. The loader owns the lifecycle of module-origin agents (upsert on
  // load, delete on uninstall); update() deliberately cannot change it.
  origin: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface AgentTask {
  id: number;
  agentId: number;
  parentId: number | null;
  prompt: string;
  status: AgentTaskStatus;
  executionMode: AgentExecutionMode;
  priority: number;
  depth: number;
  conversationId: number | null;
  virtualChatId: number | null;
  // Grant ceiling inherited from the spawning task (null = none).
  toolAllowlistOverride: string[] | null;
  // Per-run thinking override. null = inherit the agent's thinkMode; otherwise
  // wins over it for this run only.
  thinkMode: ThinkMode | null;
  // Autonomous-run state, checkpointed after each step for durable resume.
  // null plan = not started yet (the loop asks the model to author one).
  plan: AgentPlan | null;
  stepCursor: number;
  roundsUsed: number;
  // Pending user interjections, drained by the loop between steps.
  steerQueue: string[];
  checkpointAt: number | null;
  result: string | null;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  pausedUntil: number | null;
  // Throttled snapshot of the current turn's streaming reasoning/output, for the
  // separate-process panel's run view. Transient; null when not running.
  liveText: string | null;
  // Chat to notify when this task reaches a terminal state (Telegram /dispatch
  // records its chat here). null = no notification — delegated/spawned tasks.
  notifyChatId: number | null;
}

export interface CreateAgentInput {
  name: string;
  role?: string;
  systemPrompt: string;
  toolAllowlist?: string[] | null;
  profile?: ProfileName;
  thinkMode?: ThinkMode;
  maxToolRounds?: number;
  budgetTokens?: number | null;
  executionMode?: AgentExecutionMode;
  maxConcurrency?: number;
  canDelegate?: boolean;
  delegatableAgents?: string[];
  mode?: AgentMode;
  maxWallClockMs?: number | null;
  maxTotalRounds?: number | null;
  origin?: string | null;
}

export type UpdateAgentInput = Partial<Omit<CreateAgentInput, 'name' | 'origin'>> & {
  name?: string;
};

export interface EnqueueTaskInput {
  agentId: number;
  prompt: string;
  parentId?: number | null;
  executionMode?: AgentExecutionMode;
  priority?: number;
  depth?: number;
  toolAllowlistOverride?: string[] | null;
  // Per-run thinking override (auto|on|off). Omit/null to inherit the agent's.
  thinkMode?: ThinkMode | null;
  // Chat to notify when the task finishes. Set by chat-surface dispatches
  // (Telegram /dispatch); omit for delegated/spawned tasks and fleet tools.
  notifyChatId?: number | null;
}

export interface AgentTaskFilter {
  status?: AgentTaskStatus | AgentTaskStatus[];
  agentId?: number;
  parentId?: number | null;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Row <-> object mapping
// ---------------------------------------------------------------------------

interface AgentRow {
  id: number;
  name: string;
  role: string;
  system_prompt: string;
  tool_allowlist: string | null;
  profile: string;
  think_mode: string;
  max_tool_rounds: number;
  budget_tokens: number | null;
  execution_mode: string;
  max_concurrency: number;
  can_delegate: number;
  delegatable_agents: string;
  mode: string;
  max_wall_clock_ms: number | null;
  max_total_rounds: number | null;
  origin: string | null;
  created_at: number;
  updated_at: number;
}

function parseStringArray(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

// Parse a checkpointed plan, tolerating partial/garbage JSON (returns null so
// the loop re-authors rather than throwing mid-resume).
function parsePlan(json: string | null): AgentPlan | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as { steps?: unknown };
    if (!v || !Array.isArray(v.steps)) return null;
    const steps = v.steps
      .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
      .map((s) => ({
        id: String(s['id'] ?? ''),
        title: String(s['title'] ?? ''),
        status: (['pending', 'active', 'done'].includes(String(s['status']))
          ? s['status']
          : 'pending') as PlanStepStatus,
      }))
      .filter((s) => s.id !== '');
    return { steps };
  } catch {
    return null;
  }
}

function rowToAgent(r: AgentRow): AgentDefinition {
  return {
    id: r.id,
    name: r.name,
    role: r.role,
    systemPrompt: r.system_prompt,
    toolAllowlist: r.tool_allowlist === null ? null : parseStringArray(r.tool_allowlist),
    profile: r.profile as ProfileName,
    thinkMode: r.think_mode as ThinkMode,
    maxToolRounds: r.max_tool_rounds,
    budgetTokens: r.budget_tokens,
    executionMode: r.execution_mode as AgentExecutionMode,
    maxConcurrency: r.max_concurrency,
    canDelegate: r.can_delegate !== 0,
    delegatableAgents: parseStringArray(r.delegatable_agents),
    mode: r.mode === 'autonomous' ? 'autonomous' : 'single',
    maxWallClockMs: r.max_wall_clock_ms,
    maxTotalRounds: r.max_total_rounds,
    origin: r.origin ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

interface TaskRow {
  id: number;
  agent_id: number;
  parent_id: number | null;
  prompt: string;
  status: string;
  execution_mode: string;
  priority: number;
  depth: number;
  conversation_id: number | null;
  virtual_chat_id: number | null;
  tool_allowlist_override: string | null;
  think_mode: string | null;
  plan_json: string | null;
  step_cursor: number;
  rounds_used: number;
  steer_queue_json: string | null;
  checkpoint_at: number | null;
  result: string | null;
  error: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  paused_until: number | null;
  live_text: string | null;
  notify_chat_id: number | null;
}

function rowToTask(r: TaskRow): AgentTask {
  return {
    id: r.id,
    agentId: r.agent_id,
    parentId: r.parent_id,
    prompt: r.prompt,
    status: r.status as AgentTaskStatus,
    executionMode: r.execution_mode as AgentExecutionMode,
    priority: r.priority,
    depth: r.depth,
    conversationId: r.conversation_id,
    virtualChatId: r.virtual_chat_id,
    toolAllowlistOverride:
      r.tool_allowlist_override === null ? null : parseStringArray(r.tool_allowlist_override),
    thinkMode: r.think_mode === null ? null : (r.think_mode as ThinkMode),
    plan: parsePlan(r.plan_json),
    stepCursor: r.step_cursor ?? 0,
    roundsUsed: r.rounds_used ?? 0,
    steerQueue: parseStringArray(r.steer_queue_json),
    checkpointAt: r.checkpoint_at ?? null,
    result: r.result,
    error: r.error,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    pausedUntil: r.paused_until ?? null,
    liveText: r.live_text ?? null,
    notifyChatId: r.notify_chat_id ?? null,
  };
}

// ---------------------------------------------------------------------------
// AgentRegistry — CRUD over agents + agent_tasks
// ---------------------------------------------------------------------------

export interface AgentRegistry {
  create(input: CreateAgentInput): AgentDefinition;
  get(id: number): AgentDefinition | undefined;
  getByName(name: string): AgentDefinition | undefined;
  list(): AgentDefinition[];
  update(id: number, patch: UpdateAgentInput): AgentDefinition | undefined;
  remove(id: number): boolean;

  enqueue(input: EnqueueTaskInput): AgentTask;
  getTask(id: number): AgentTask | undefined;
  listTasks(filter?: AgentTaskFilter): AgentTask[];
  // Status transitions used by the runner/queue. `patch` carries the fields
  // that change with each transition (started_at on running, result/error +
  // finished_at on terminal states, the conversation link once known).
  updateTask(
    id: number,
    patch: Partial<
      Pick<
        AgentTask,
        | 'status'
        | 'result'
        | 'error'
        | 'conversationId'
        | 'virtualChatId'
        | 'pausedUntil'
        | 'plan'
        | 'stepCursor'
        | 'roundsUsed'
        | 'steerQueue'
        | 'checkpointAt'
        | 'liveText'
      >
    > & { startedAt?: number; finishedAt?: number },
  ): void;
  // Append a user interjection to a task's steer queue (read-modify-write under
  // the DB's single-writer lock). Returns false if the task is gone.
  pushSteer(taskId: number, text: string): boolean;

  // Artifacts an autonomous run saved.
  addArtifact(input: {
    taskId: number;
    name: string;
    content: string | null;
    mime?: string;
  }): AgentArtifact;
  listArtifacts(taskId: number): AgentArtifact[];

  // Input attachments dropped into a task (bytes live on disk; this is metadata).
  addAttachment(input: {
    taskId: number;
    kind: AttachmentKind;
    name: string;
    path: string;
    mime?: string;
    bytes?: number;
  }): AgentAttachment;
  listAttachments(taskId: number): AgentAttachment[];
}

export function createAgentRegistry(db: DB): AgentRegistry {
  const insertAgent = db.prepare(
    `INSERT INTO agents
       (name, role, system_prompt, tool_allowlist, profile, think_mode, max_tool_rounds,
        budget_tokens, execution_mode, max_concurrency, can_delegate,
        delegatable_agents, mode, max_wall_clock_ms, max_total_rounds, origin, created_at, updated_at)
     VALUES (@name, @role, @system_prompt, @tool_allowlist, @profile, @think_mode, @max_tool_rounds,
             @budget_tokens, @execution_mode, @max_concurrency, @can_delegate,
             @delegatable_agents, @mode, @max_wall_clock_ms, @max_total_rounds, @origin, @created_at, @updated_at)`,
  );
  const selectById = db.prepare(`SELECT * FROM agents WHERE id = ?`);
  const selectByName = db.prepare(`SELECT * FROM agents WHERE name = ?`);
  const selectAll = db.prepare(`SELECT * FROM agents ORDER BY name`);
  const deleteById = db.prepare(`DELETE FROM agents WHERE id = ?`);

  const insertTask = db.prepare(
    `INSERT INTO agent_tasks
       (agent_id, parent_id, prompt, status, execution_mode, priority, depth,
        tool_allowlist_override, think_mode, notify_chat_id, created_at)
     VALUES (@agent_id, @parent_id, @prompt, 'queued', @execution_mode, @priority, @depth,
             @tool_allowlist_override, @think_mode, @notify_chat_id, @created_at)`,
  );
  const selectTaskById = db.prepare(`SELECT * FROM agent_tasks WHERE id = ?`);

  function get(id: number): AgentDefinition | undefined {
    const row = selectById.get(id) as AgentRow | undefined;
    return row ? rowToAgent(row) : undefined;
  }

  function getByName(name: string): AgentDefinition | undefined {
    const row = selectByName.get(name) as AgentRow | undefined;
    return row ? rowToAgent(row) : undefined;
  }

  function create(input: CreateAgentInput): AgentDefinition {
    const now = Date.now();
    const allowlist = input.toolAllowlist === undefined ? null : input.toolAllowlist;
    const info = insertAgent.run({
      name: input.name,
      role: input.role ?? '',
      system_prompt: input.systemPrompt,
      tool_allowlist: allowlist === null ? null : JSON.stringify(allowlist),
      profile: input.profile ?? 'chat',
      think_mode: input.thinkMode ?? 'auto',
      max_tool_rounds: input.maxToolRounds ?? 4,
      budget_tokens: input.budgetTokens ?? null,
      execution_mode: input.executionMode ?? 'sequential',
      max_concurrency: input.maxConcurrency ?? 1,
      can_delegate: input.canDelegate ? 1 : 0,
      delegatable_agents: JSON.stringify(input.delegatableAgents ?? []),
      mode: input.mode ?? 'single',
      max_wall_clock_ms: input.maxWallClockMs ?? null,
      max_total_rounds: input.maxTotalRounds ?? null,
      origin: input.origin ?? null,
      created_at: now,
      updated_at: now,
    });
    return get(Number(info.lastInsertRowid))!;
  }

  function update(id: number, patch: UpdateAgentInput): AgentDefinition | undefined {
    const current = get(id);
    if (!current) return undefined;
    const next: AgentDefinition = {
      ...current,
      ...('name' in patch && patch.name !== undefined ? { name: patch.name } : {}),
      ...('role' in patch && patch.role !== undefined ? { role: patch.role } : {}),
      ...('systemPrompt' in patch && patch.systemPrompt !== undefined
        ? { systemPrompt: patch.systemPrompt }
        : {}),
      ...('toolAllowlist' in patch ? { toolAllowlist: patch.toolAllowlist ?? null } : {}),
      ...('profile' in patch && patch.profile !== undefined ? { profile: patch.profile } : {}),
      ...('thinkMode' in patch && patch.thinkMode !== undefined
        ? { thinkMode: patch.thinkMode }
        : {}),
      ...('maxToolRounds' in patch && patch.maxToolRounds !== undefined
        ? { maxToolRounds: patch.maxToolRounds }
        : {}),
      ...('budgetTokens' in patch ? { budgetTokens: patch.budgetTokens ?? null } : {}),
      ...('executionMode' in patch && patch.executionMode !== undefined
        ? { executionMode: patch.executionMode }
        : {}),
      ...('maxConcurrency' in patch && patch.maxConcurrency !== undefined
        ? { maxConcurrency: patch.maxConcurrency }
        : {}),
      ...('canDelegate' in patch && patch.canDelegate !== undefined
        ? { canDelegate: patch.canDelegate }
        : {}),
      ...('delegatableAgents' in patch && patch.delegatableAgents !== undefined
        ? { delegatableAgents: patch.delegatableAgents }
        : {}),
      ...('mode' in patch && patch.mode !== undefined ? { mode: patch.mode } : {}),
      ...('maxWallClockMs' in patch ? { maxWallClockMs: patch.maxWallClockMs ?? null } : {}),
      ...('maxTotalRounds' in patch ? { maxTotalRounds: patch.maxTotalRounds ?? null } : {}),
      updatedAt: Date.now(),
    };
    db.prepare(
      `UPDATE agents SET
         name = @name, role = @role, system_prompt = @system_prompt,
         tool_allowlist = @tool_allowlist, profile = @profile, think_mode = @think_mode,
         max_tool_rounds = @max_tool_rounds, budget_tokens = @budget_tokens,
         execution_mode = @execution_mode, max_concurrency = @max_concurrency,
         can_delegate = @can_delegate, delegatable_agents = @delegatable_agents,
         mode = @mode, max_wall_clock_ms = @max_wall_clock_ms,
         max_total_rounds = @max_total_rounds, updated_at = @updated_at
       WHERE id = @id`,
    ).run({
      id,
      name: next.name,
      role: next.role,
      system_prompt: next.systemPrompt,
      tool_allowlist: next.toolAllowlist === null ? null : JSON.stringify(next.toolAllowlist),
      profile: next.profile,
      think_mode: next.thinkMode,
      max_tool_rounds: next.maxToolRounds,
      budget_tokens: next.budgetTokens,
      execution_mode: next.executionMode,
      max_concurrency: next.maxConcurrency,
      can_delegate: next.canDelegate ? 1 : 0,
      delegatable_agents: JSON.stringify(next.delegatableAgents),
      mode: next.mode,
      max_wall_clock_ms: next.maxWallClockMs,
      max_total_rounds: next.maxTotalRounds,
      updated_at: next.updatedAt,
    });
    return get(id);
  }

  function remove(id: number): boolean {
    return deleteById.run(id).changes > 0;
  }

  function enqueue(input: EnqueueTaskInput): AgentTask {
    const override = input.toolAllowlistOverride;
    const info = insertTask.run({
      agent_id: input.agentId,
      parent_id: input.parentId ?? null,
      prompt: input.prompt,
      execution_mode: input.executionMode ?? 'sequential',
      priority: input.priority ?? 0,
      depth: input.depth ?? 0,
      tool_allowlist_override:
        override === undefined || override === null ? null : JSON.stringify(override),
      think_mode: input.thinkMode ?? null,
      notify_chat_id: input.notifyChatId ?? null,
      created_at: Date.now(),
    });
    return getTask(Number(info.lastInsertRowid))!;
  }

  function getTask(id: number): AgentTask | undefined {
    const row = selectTaskById.get(id) as TaskRow | undefined;
    return row ? rowToTask(row) : undefined;
  }

  function listTasks(filter: AgentTaskFilter = {}): AgentTask[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      where.push(`status IN (${statuses.map(() => '?').join(', ')})`);
      params.push(...statuses);
    }
    if (filter.agentId !== undefined) {
      where.push('agent_id = ?');
      params.push(filter.agentId);
    }
    if (filter.parentId !== undefined) {
      if (filter.parentId === null) {
        where.push('parent_id IS NULL');
      } else {
        where.push('parent_id = ?');
        params.push(filter.parentId);
      }
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = filter.limit ? `LIMIT ${Math.max(1, Math.floor(filter.limit))}` : '';
    const rows = db
      .prepare(`SELECT * FROM agent_tasks ${clause} ORDER BY id DESC ${limit}`)
      .all(...params) as TaskRow[];
    return rows.map(rowToTask);
  }

  function updateTask(
    id: number,
    patch: Partial<
      Pick<
        AgentTask,
        | 'status'
        | 'result'
        | 'error'
        | 'conversationId'
        | 'virtualChatId'
        | 'pausedUntil'
        | 'plan'
        | 'stepCursor'
        | 'roundsUsed'
        | 'steerQueue'
        | 'checkpointAt'
        | 'liveText'
      >
    > & { startedAt?: number; finishedAt?: number },
  ): void {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };
    const add = (col: string, key: string, val: unknown): void => {
      sets.push(`${col} = @${key}`);
      params[key] = val;
    };
    if (patch.status !== undefined) add('status', 'status', patch.status);
    if (patch.result !== undefined) add('result', 'result', patch.result);
    if (patch.error !== undefined) add('error', 'error', patch.error);
    if (patch.conversationId !== undefined)
      add('conversation_id', 'conversation_id', patch.conversationId);
    if (patch.virtualChatId !== undefined)
      add('virtual_chat_id', 'virtual_chat_id', patch.virtualChatId);
    if (patch.startedAt !== undefined) add('started_at', 'started_at', patch.startedAt);
    if (patch.finishedAt !== undefined) add('finished_at', 'finished_at', patch.finishedAt);
    if (patch.pausedUntil !== undefined) add('paused_until', 'paused_until', patch.pausedUntil);
    if (patch.plan !== undefined)
      add('plan_json', 'plan_json', patch.plan === null ? null : JSON.stringify(patch.plan));
    if (patch.stepCursor !== undefined) add('step_cursor', 'step_cursor', patch.stepCursor);
    if (patch.roundsUsed !== undefined) add('rounds_used', 'rounds_used', patch.roundsUsed);
    if (patch.steerQueue !== undefined)
      add('steer_queue_json', 'steer_queue_json', JSON.stringify(patch.steerQueue));
    if (patch.checkpointAt !== undefined) add('checkpoint_at', 'checkpoint_at', patch.checkpointAt);
    if (patch.liveText !== undefined) add('live_text', 'live_text', patch.liveText);
    if (sets.length === 0) return;
    db.prepare(`UPDATE agent_tasks SET ${sets.join(', ')} WHERE id = @id`).run(params);
  }

  // Append to the steer queue read-modify-write. better-sqlite3 is synchronous
  // and single-writer, so this is atomic with respect to the loop's drain.
  function pushSteer(taskId: number, text: string): boolean {
    const task = getTask(taskId);
    if (!task) return false;
    updateTask(taskId, { steerQueue: [...task.steerQueue, text] });
    return true;
  }

  const insertArtifact = db.prepare(
    `INSERT INTO agent_artifacts (task_id, name, mime, content, created_at)
     VALUES (@task_id, @name, @mime, @content, @created_at)`,
  );
  function addArtifact(input: {
    taskId: number;
    name: string;
    content: string | null;
    mime?: string;
  }): AgentArtifact {
    const created = Date.now();
    const info = insertArtifact.run({
      task_id: input.taskId,
      name: input.name,
      mime: input.mime ?? 'text/plain',
      content: input.content,
      created_at: created,
    });
    return {
      id: Number(info.lastInsertRowid),
      taskId: input.taskId,
      name: input.name,
      mime: input.mime ?? 'text/plain',
      content: input.content,
      createdAt: created,
    };
  }
  function listArtifacts(taskId: number): AgentArtifact[] {
    const rows = db
      .prepare(`SELECT * FROM agent_artifacts WHERE task_id = ? ORDER BY id`)
      .all(taskId) as Array<{
      id: number;
      task_id: number;
      name: string;
      mime: string;
      content: string | null;
      created_at: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      taskId: r.task_id,
      name: r.name,
      mime: r.mime,
      content: r.content,
      createdAt: r.created_at,
    }));
  }

  const insertAttachment = db.prepare(
    `INSERT INTO agent_task_attachments (task_id, kind, name, path, mime, bytes, created_at)
     VALUES (@task_id, @kind, @name, @path, @mime, @bytes, @created_at)`,
  );
  function addAttachment(input: {
    taskId: number;
    kind: AttachmentKind;
    name: string;
    path: string;
    mime?: string;
    bytes?: number;
  }): AgentAttachment {
    const created = Date.now();
    const mime = input.mime ?? 'application/octet-stream';
    const bytes = input.bytes ?? 0;
    const info = insertAttachment.run({
      task_id: input.taskId,
      kind: input.kind,
      name: input.name,
      path: input.path,
      mime,
      bytes,
      created_at: created,
    });
    return {
      id: Number(info.lastInsertRowid),
      taskId: input.taskId,
      kind: input.kind,
      name: input.name,
      path: input.path,
      mime,
      bytes,
      createdAt: created,
    };
  }
  function listAttachments(taskId: number): AgentAttachment[] {
    const rows = db
      .prepare(`SELECT * FROM agent_task_attachments WHERE task_id = ? ORDER BY id`)
      .all(taskId) as Array<{
      id: number;
      task_id: number;
      kind: AttachmentKind;
      name: string;
      path: string;
      mime: string;
      bytes: number;
      created_at: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      taskId: r.task_id,
      kind: r.kind,
      name: r.name,
      path: r.path,
      mime: r.mime,
      bytes: r.bytes,
      createdAt: r.created_at,
    }));
  }

  return {
    create,
    get,
    getByName,
    list: () => (selectAll.all() as AgentRow[]).map(rowToAgent),
    update,
    remove,
    enqueue,
    getTask,
    listTasks,
    updateTask,
    pushSteer,
    addArtifact,
    listArtifacts,
    addAttachment,
    listAttachments,
  };
}

// Seed a small, useful starter fleet on a fresh install (no-op if any agent
// already exists, so deleting them sticks). These demonstrate the two ways
// small models get to quality: a sparing heavy Planner that decomposes and
// delegates, and cheap tiny-model workers each kept to a narrow job.
export function seedStarterAgents(registry: AgentRegistry): void {
  const existing = registry.list();
  if (registry.getByName('orchestrator')) return;
  if (existing.length > 0) {
    registry.create({
      name: 'orchestrator',
      role: 'Coordinates any task across the available agent fleet',
      systemPrompt:
        'You are the Orchestrator. For any user task, decide whether to answer directly or break it ' +
        'into concrete subtasks. Use spawn_agent to delegate to the best available agents from your ' +
        'current roster, wait for their results when synthesis matters, then return one clear final answer. ' +
        'Keep the plan lean and avoid spawning agents for trivial work.',
      profile: 'reason',
      toolAllowlist: [],
      executionMode: 'sequential',
      maxToolRounds: 8,
      canDelegate: true,
      delegatableAgents: [],
    });
    return;
  }
  registry.create({
    name: 'orchestrator',
    role: 'Coordinates any task across the available agent fleet',
    systemPrompt:
      'You are the Orchestrator. For any user task, decide whether to answer directly or break it ' +
      'into concrete subtasks. Use spawn_agent to delegate to the best available agents from your ' +
      'current roster, wait for their results when synthesis matters, then return one clear final answer. ' +
      'Keep the plan lean and avoid spawning agents for trivial work.',
    profile: 'reason',
    toolAllowlist: [],
    executionMode: 'sequential',
    maxToolRounds: 8,
    canDelegate: true,
    delegatableAgents: [],
  });
  registry.create({
    name: 'researcher',
    role: 'Gathers facts using available tools',
    systemPrompt:
      'You are a focused research agent. Use the available tools to gather the facts you need, ' +
      'then report them concisely. Do not speculate beyond what the tools return.',
    profile: 'tools',
    toolAllowlist: null,
    executionMode: 'parallel',
    maxConcurrency: 2,
  });
  registry.create({
    name: 'writer',
    role: 'Drafts clear prose from notes',
    systemPrompt:
      'You are a writing agent. Turn the provided notes into clear, concise prose. ' +
      'No tools — just write.',
    profile: 'chat',
    toolAllowlist: [],
  });
  registry.create({
    name: 'critic',
    role: 'Reviews and tightens a draft',
    systemPrompt:
      'You are a critic. Review the provided draft for clarity, accuracy, and concision, ' +
      'then return an improved version. Be specific about what you changed.',
    profile: 'chat',
    toolAllowlist: [],
  });
  // The flagship long-horizon agent: it plans, works the plan over many turns,
  // delegates to the workers above, and finishes on its own. Demonstrates the
  // autonomous loop out of the box. Budgets are deliberately modest so a stray
  // run can't grind forever on a small box; raise them in the editor.
  registry.create({
    name: 'operator',
    role: 'Plans and runs a multi-step task end to end',
    systemPrompt:
      'You are the Operator, an autonomous agent that completes complex tasks end to end. ' +
      'Break the goal into a concrete plan, work it step by step using your tools and the worker ' +
      'agents available to you, keep notes of what you find, and deliver a clear final result. ' +
      'Prefer delegating focused subtasks (research, drafting, review) to the smallest capable agent.',
    profile: 'reason',
    toolAllowlist: null,
    mode: 'autonomous',
    executionMode: 'sequential',
    maxToolRounds: 6,
    canDelegate: true,
    delegatableAgents: [],
    maxTotalRounds: 24,
    maxWallClockMs: 30 * 60_000,
  });
}

// ---------------------------------------------------------------------------
// Filtered tool-registry view
// ---------------------------------------------------------------------------

// Predicate from an allowlist: an entry matches a tool by its own name or by
// the name of the module that registered it. null = allow everything.
export function agentToolPredicate(allowlist: string[] | null): (h: ToolHandler) => boolean {
  if (allowlist === null) return () => true;
  const set = new Set(allowlist);
  return (h) => set.has(h.name) || (h.module !== undefined && set.has(h.module));
}

// A read-through ToolRegistry that only exposes handlers the predicate admits.
// list/get/schemas/schemasFor are narrowed; execute fails closed on a hidden
// tool (defense in depth — the orchestrator's per-turn gate already blocks
// out-of-manifest names, but a delegated worker must never reach a tool
// outside its grant even via a forced/auto-routed call). register/unregister/
// onAfterExecute delegate straight through to the base registry.
export function filterToolRegistry(
  base: ToolRegistry,
  predicate: (h: ToolHandler) => boolean,
): ToolRegistry {
  const visibleNames = (): Set<string> =>
    new Set(
      base
        .list()
        .filter(predicate)
        .map((h) => h.name),
    );
  return {
    register: (h) => base.register(h),
    unregister: (n) => base.unregister(n),
    list: () => base.list().filter(predicate),
    get: (name) => {
      const h = base.get(name);
      return h && predicate(h) ? h : undefined;
    },
    schemas: () => {
      const names = visibleNames();
      return base.schemas().filter((s) => names.has(s.function.name));
    },
    schemasFor: (moduleNames, inputText) => {
      const names = visibleNames();
      return base.schemasFor(moduleNames, inputText).filter((s) => names.has(s.function.name));
    },
    execute: async (call, ctx) => {
      const h = base.get(call.name);
      if (!h || !predicate(h)) {
        return { call, ok: false, output: `tool '${call.name}' is not available to this agent` };
      }
      return base.execute(call, ctx);
    },
    onAfterExecute: (n, l) => base.onAfterExecute(n, l),
  };
}

// ---------------------------------------------------------------------------
// AgentRuntime — headless execution of a task through the orchestrator
// ---------------------------------------------------------------------------

export interface AgentRuntimeOptions {
  db: DB;
  llm: LLM;
  // Base registry holding every registered tool. Each agent gets a filtered
  // view of this.
  tools: ToolRegistry;
  log: Logger;
  registry: AgentRegistry;
  // User id stamped on the agent's conversation row (telegram_chats.user_id is
  // NOT NULL). The bot owner's id; tests pass any number.
  ownerUserId: number;
  // Maximum number of tokens allowed for the agent's prompt context.
  budgetTokens?: number;
  // Maximum number of characters of a tool's output to inject into context.
  toolResultMaxChars?: number;
  // Per-inference timeout (ms) for every model call an agent makes. Set well
  // above the chat default (120s) so a slow model on CPU — e.g. a 12B research
  // round — runs to completion instead of being aborted and mistaken for a
  // cancellation. Unset leaves the LLM default in force.
  inferenceTimeoutMs?: number;
  // Base directory for per-task input attachments (~/.modulus/agent-attachments).
  // When set, a task's image attachments are fed to a multimodal model on its
  // first turn. The pinned read_file/list_dir root is wired separately (start.ts).
  attachmentsDir?: string;
  // Hive-mind hooks. memoryProvider fills the prompt's memory slot on every
  // agent turn from the same store the main chat uses — that's what makes the
  // fleet share one memory. buildOrchestrator passes the running agent's id so
  // recall is namespace-scoped (global ∪ that agent's private rows). onTaskDone
  // fires after a task reaches 'done'; start.ts wires it to promote the task's
  // recorded findings into that agent's namespace. Both are best-effort: a
  // throwing hook is logged, never fatal to the run.
  memoryProvider?: (message: string, agentId?: number) => string | undefined;
  onTaskDone?: (task: AgentTask, agent: AgentDefinition) => void;
}

export interface RunResult {
  ok: boolean;
  text: string;
  error?: string;
  conversationId: number;
}

// Live events emitted during a run, for the panel's SSE stream. `delta` carries
// streamed model text; the rest report autonomous-loop progress.
export type AgentRunEvent =
  | { type: 'delta'; text: string }
  | { type: 'plan'; plan: AgentPlan }
  | { type: 'phase'; phase: 'planning' | 'working' | 'finalizing' }
  | {
      type: 'budget';
      roundsUsed: number;
      maxRounds: number;
      wallMs: number;
      maxWallMs: number;
    }
  | { type: 'done'; ok: boolean };

// Streaming hooks + result for a direct-chat (DM) turn with an agent persona.
export interface AgentChatOptions {
  thinkMode?: ThinkMode | null;
  onDelta?: (delta: string) => void;
  onThinking?: (thinking: string) => void;
}

export interface AgentChatResult {
  ok: boolean;
  text: string;
  error?: string;
}

export interface AgentRuntime {
  // Run a queued task to completion. Marks it running, drives the orchestrator,
  // persists result/error + the conversation link, returns the outcome.
  runTask(taskId: number, opts?: { onDelta?: (delta: string) => void }): Promise<RunResult>;
  // Best-effort cancellation for a queued or running task. Running tasks abort
  // their active orchestrator turn; queued tasks are marked terminal.
  cancelTask(taskId: number): boolean;
  // Subscribe to a task's live events (panel SSE). Returns an unsubscribe fn.
  subscribe(taskId: number, fn: (e: AgentRunEvent) => void): () => void;
  // Direct chat with an agent persona on its persistent DM conversation
  // (agentDmChatId). Interactive like the main panel chat — it does NOT go
  // through the task queue; the loop/planning/delegation tools are excluded.
  // One turn per agent at a time: a second send while busy is rejected.
  chat(agentId: number, text: string, opts?: AgentChatOptions): Promise<AgentChatResult>;
  // Abort the in-flight DM turn for an agent, if any.
  stopChat(agentId: number): boolean;
  // Wipe the agent's DM history (conversations + messages for its DM chat id).
  clearChat(agentId: number): void;
  chatBusy(agentId: number): boolean;
  shutdown(): Promise<void>;
}

export function createAgentRuntime(opts: AgentRuntimeOptions): AgentRuntime {
  const log = opts.log.child({ mod: 'agent-runtime' });
  // One orchestrator per agent definition, rebuilt when the definition changes
  // (keyed by updatedAt). The expensive resources — db, llm, base tool
  // registry — are shared singletons; an orchestrator is a thin wrapper.
  const cache = new Map<number, { cacheKey: string; orch: Orchestrator }>();
  const active = new Map<number, { orch: Orchestrator; virtualChatId: number }>();

  // Build the tool-visibility predicate for an agent. The delegation tool is
  // visible iff the agent may delegate (independent of its allowlist); an
  // optional grant ceiling (from a spawning task) is ANDed on top.
  function agentPredicate(
    agent: AgentDefinition,
    override: string[] | null,
  ): (h: ToolHandler) => boolean {
    const own = agentToolPredicate(agent.toolAllowlist);
    const ceiling = agentToolPredicate(override);
    return (h) => {
      if (h.name === SPAWN_AGENT_TOOL_NAME || h.name === SPAWN_AGENTS_TOOL_NAME)
        return agent.canDelegate;
      // Every agent may ask for human approval, regardless of its tool grant.
      if (h.name === REQUEST_APPROVAL_TOOL_NAME) return true;
      // Planning/loop tools are meaningful only inside the autonomous loop.
      if (isPlanningTool(h.name)) return agent.mode === 'autonomous';
      return own(h) && ceiling(h);
    };
  }

  // Tool view for a DM turn: the agent's own allowlist, minus every task-run
  // affordance. Delegation/approval/planning tools all resolve their task via
  // ctx.chatId - AGENT_CHAT_ID_BASE, which is meaningless on a DM conversation,
  // so they must never be visible there.
  function dmPredicate(agent: AgentDefinition): (h: ToolHandler) => boolean {
    const own = agentToolPredicate(agent.toolAllowlist);
    return (h) =>
      h.name !== SPAWN_AGENT_TOOL_NAME &&
      h.name !== SPAWN_AGENTS_TOOL_NAME &&
      h.name !== REQUEST_APPROVAL_TOOL_NAME &&
      !isPlanningTool(h.name) &&
      own(h);
  }

  function buildOrchestrator(
    agent: AgentDefinition,
    override: string[] | null,
    dm = false,
  ): Orchestrator {
    const tools = filterToolRegistry(
      opts.tools,
      dm ? dmPredicate(agent) : agentPredicate(agent, override),
    );
    let systemPrompt = agent.systemPrompt;
    // DM turns are conversational: no delegate roster (spawn_agent is hidden)
    // and no autonomous loop contract (its planning tools are hidden too).
    if (!dm && agent.canDelegate)
      systemPrompt = `${systemPrompt}\n\n${delegateRosterPrompt(agent)}`;
    if (!dm && agent.mode === 'autonomous')
      systemPrompt = `${systemPrompt}\n\n${AUTONOMOUS_PREAMBLE}`;
    return createOrchestrator({
      db: opts.db,
      llm: opts.llm,
      tools,
      log: opts.log.child({ agent: agent.name }),
      systemPrompt,
      defaultProfile: agent.profile,
      // The persona runs on a single model; use it for tool turns too rather
      // than falling back to the global chat model.
      toolProfile: agent.profile,
      // Agents are explicitly configured personas with their own tool grant.
      // Deterministic auto-route (e.g. modulus-codex claiming any turn whose
      // prompt contains "research") is a main-chat affordance for the tiny chat
      // model and would otherwise hijack a research agent's turn before it can
      // reach its own tools (websearch). The agent can still call such a tool
      // explicitly if it's in its allowlist.
      autoRouteEnabled: false,
      // 'auto' keeps the profile/model default; only force when explicitly set.
      ...(agent.thinkMode !== 'auto' ? { defaultThinkMode: agent.thinkMode } : {}),
      maxToolRounds: agent.maxToolRounds,
      ...(agent.budgetTokens
        ? { budgetTokens: agent.budgetTokens }
        : opts.budgetTokens
          ? { budgetTokens: opts.budgetTokens }
          : {}),
      ...(opts.toolResultMaxChars ? { toolResultMaxChars: opts.toolResultMaxChars } : {}),
      ...(opts.inferenceTimeoutMs ? { inferenceTimeoutMs: opts.inferenceTimeoutMs } : {}),
      // Bind this agent's id so recall is scoped to global ∪ its namespace; the
      // orchestrator's own provider type stays (message) => … unchanged.
      ...(opts.memoryProvider
        ? { memoryProvider: (m: string) => opts.memoryProvider!(m, agent.id) }
        : {}),
    });
  }

  function delegateRoster(agent: AgentDefinition): AgentDefinition[] {
    if (!agent.canDelegate) return [];
    const allowed = new Set(agent.delegatableAgents);
    return opts.registry
      .list()
      .filter((candidate) => candidate.id !== agent.id)
      .filter((candidate) => allowed.size === 0 || allowed.has(candidate.name));
  }

  function delegateRosterPrompt(agent: AgentDefinition): string {
    const roster = delegateRoster(agent);
    if (roster.length === 0) {
      return 'No delegate agents are currently available. Do not call spawn_agent.';
    }
    const lines = roster.map(
      (candidate) =>
        `- ${candidate.name}: ${candidate.role || candidate.systemPrompt.slice(0, 90)} (${candidate.profile})`,
    );
    return [
      'Available delegate agents for spawn_agent:',
      ...lines,
      'Pick the smallest suitable agent for each subtask. Use exact agent names.',
      'For several independent subtasks, call spawn_agents once with a list to run ' +
        'lightweight workers in parallel; use spawn_agent for a single subtask or a heavy agent.',
    ].join('\n');
  }

  function orchestratorCacheKey(agent: AgentDefinition): string {
    if (!agent.canDelegate) return String(agent.updatedAt);
    return `${agent.updatedAt}:${delegateRoster(agent)
      .map(
        (candidate) => `${candidate.id}:${candidate.name}:${candidate.role}:${candidate.updatedAt}`,
      )
      .join('|')}`;
  }

  // Cache the common case — an agent run with no grant ceiling — keyed by the
  // definition's updatedAt. Runs that carry a per-task override get a one-off
  // orchestrator that's torn down after the run.
  function orchestratorFor(agent: AgentDefinition): Orchestrator {
    const hit = cache.get(agent.id);
    const cacheKey = orchestratorCacheKey(agent);
    if (hit && hit.cacheKey === cacheKey) return hit.orch;
    if (hit) void hit.orch.shutdown();
    const orch = buildOrchestrator(agent, null);
    cache.set(agent.id, { cacheKey, orch });
    return orch;
  }

  // DM orchestrators are cached separately: same persona, different tool view
  // and prompt (no roster/preamble), keyed by updatedAt alone since the
  // delegate roster never appears in a DM prompt.
  const dmCache = new Map<number, { cacheKey: string; orch: Orchestrator }>();
  function dmOrchestratorFor(agent: AgentDefinition): Orchestrator {
    const hit = dmCache.get(agent.id);
    const cacheKey = String(agent.updatedAt);
    if (hit && hit.cacheKey === cacheKey) return hit.orch;
    if (hit) void hit.orch.shutdown();
    const orch = buildOrchestrator(agent, null, true);
    dmCache.set(agent.id, { cacheKey, orch });
    return orch;
  }

  // -- live event bus (panel SSE) -------------------------------------------
  const subscribers = new Map<number, Set<(e: AgentRunEvent) => void>>();
  function emit(taskId: number, e: AgentRunEvent): void {
    const set = subscribers.get(taskId);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(e);
      } catch {
        /* a dead subscriber must never kill the run */
      }
    }
  }
  function subscribe(taskId: number, fn: (e: AgentRunEvent) => void): () => void {
    let set = subscribers.get(taskId);
    if (!set) {
      set = new Set();
      subscribers.set(taskId, set);
    }
    set.add(fn);
    return () => {
      const s = subscribers.get(taskId);
      if (!s) return;
      s.delete(fn);
      if (s.size === 0) subscribers.delete(taskId);
    };
  }

  // Drive a single orchestrator turn against the task's virtual chat and collect
  // its streamed output. Shared by single-mode and the autonomous loop.
  interface TurnResult {
    finalText: string | undefined;
    buffer: string;
    conversationId: number;
  }
  async function driveTurn(
    orch: Orchestrator,
    virtualChatId: number,
    text: string,
    thinkMode: ThinkMode | null,
    taskId: number,
    onDelta?: (delta: string) => void,
    images?: string[],
  ): Promise<TurnResult> {
    let buffer = '';
    let finalText: string | undefined;
    let conversationId = 0;
    // Live reasoning capture for the panel. The panel is a separate process that
    // only reads the DB, so we throttle-write the rolling thinking/answer to the
    // task's live_text (~1/s) — enough for a smooth "watch it think" without a
    // write per token on a Pi. Reasoning arrives in chunk.thinking (Ollama streams
    // it apart from content); the visible answer is chunk.delta.
    let thinkingBuf = '';
    let lastLiveWrite = 0;
    const tail = (s: string, n: number): string => (s.length > n ? `…${s.slice(-n)}` : s);
    const flushLive = (force: boolean): void => {
      const now = Date.now();
      if (!force && now - lastLiveWrite < LIVE_TEXT_THROTTLE_MS) return;
      lastLiveWrite = now;
      const t = thinkingBuf.trim();
      const a = buffer.trim();
      const live =
        t && a ? `${tail(t, 4000)}\n\n[answer so far]\n${tail(a, 2000)}` : tail(t || a, 6000);
      opts.registry.updateTask(taskId, { liveText: live || null });
    };
    await orch.handleUserMessage({
      chatId: virtualChatId,
      userId: opts.ownerUserId,
      text,
      ...(thinkMode ? { thinkMode } : {}),
      ...(images && images.length > 0 ? { images } : {}),
      send: (chunk: ReplyChunk) => {
        if (chunk.thinking) {
          thinkingBuf += chunk.thinking;
          flushLive(false);
        }
        if (chunk.delta) {
          buffer += chunk.delta;
          onDelta?.(chunk.delta);
          emit(taskId, { type: 'delta', text: chunk.delta });
          flushLive(false);
        }
        if (chunk.done) {
          // meta.afterTurn.assistantText is the canonical post-guard reply
          // (after hallucination scrubbing / `replace`); prefer it over the raw
          // streamed buffer.
          if (chunk.meta?.afterTurn) {
            finalText = chunk.meta.afterTurn.assistantText;
            conversationId = chunk.meta.afterTurn.conversationId;
          } else if (typeof chunk.replace === 'string') {
            finalText = chunk.replace;
          }
        }
      },
    });
    return { finalText, buffer, conversationId };
  }

  interface RunCtx {
    taskId: number;
    agent: AgentDefinition;
    virtualChatId: number;
    orch: Orchestrator;
    onDelta?: (delta: string) => void;
    // Base64 image attachments for the first turn (multimodal models only).
    images?: string[];
  }

  // Fire the hive-mind completion hook. Best-effort by contract: promotion is
  // an enrichment, so a throwing hook must never fail a finished task.
  function notifyTaskDone(taskId: number, agent: AgentDefinition): void {
    if (!opts.onTaskDone) return;
    const task = opts.registry.getTask(taskId);
    if (!task) return;
    try {
      opts.onTaskDone(task, agent);
    } catch (e) {
      log.warn('onTaskDone hook failed', {
        taskId,
        agent: agent.name,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // -- single-mode run (today's behaviour) ----------------------------------
  async function runSingle(ctx: RunCtx): Promise<RunResult> {
    const { taskId, agent, virtualChatId, orch, onDelta } = ctx;
    const task = opts.registry.getTask(taskId)!;
    let turn: TurnResult;
    try {
      turn = await driveTurn(
        orch,
        virtualChatId,
        task.prompt,
        task.thinkMode,
        taskId,
        onDelta,
        ctx.images,
      );
    } catch (e) {
      if (opts.registry.getTask(taskId)?.status === 'cancelled') {
        return { ok: false, text: '', error: AGENT_TASK_CANCELLED_MESSAGE, conversationId: 0 };
      }
      const msg = e instanceof Error ? e.message : String(e);
      log.warn('agent task threw', { taskId, agent: agent.name, error: msg });
      opts.registry.updateTask(taskId, { status: 'error', error: msg, finishedAt: Date.now() });
      emit(taskId, { type: 'done', ok: false });
      return { ok: false, text: '', error: msg, conversationId: 0 };
    }
    const conversationId = turn.conversationId;
    const text = turn.finalText ?? turn.buffer;
    if (opts.registry.getTask(taskId)?.status === 'cancelled') {
      return { ok: false, text, error: AGENT_TASK_CANCELLED_MESSAGE, conversationId };
    }
    const errored = orch.lastError(virtualChatId);
    if (errored) {
      opts.registry.updateTask(taskId, {
        status: 'error',
        error: errored,
        finishedAt: Date.now(),
        ...(conversationId ? { conversationId } : {}),
      });
      emit(taskId, { type: 'done', ok: false });
      return { ok: false, text, error: errored, conversationId };
    }
    opts.registry.updateTask(taskId, {
      status: 'done',
      result: text,
      finishedAt: Date.now(),
      liveText: null, // clear the transient streaming buffer on completion
      ...(conversationId ? { conversationId } : {}),
    });
    notifyTaskDone(taskId, agent);
    emit(taskId, { type: 'done', ok: true });
    return { ok: true, text, conversationId };
  }

  // -- autonomous plan->act->reflect loop -----------------------------------
  function continuationPrompt(task: AgentTask, steer: string[]): string {
    const lines = ['Continue working the task.', '', 'Plan so far:', renderPlan(task.plan)];
    if (steer.length > 0) {
      lines.push('', 'New guidance from the user — apply it:');
      for (const s of steer) lines.push(`- ${s}`);
    }
    lines.push(
      '',
      'Do the next unfinished step now and mark it complete. If the whole task is done, call finish.',
    );
    return lines.join('\n');
  }
  const FINALIZE_PROMPT =
    'You are out of steps or budget. Call finish now with your best final answer for the user, ' +
    'based on everything you have done so far. Do not start new work.';

  async function runAutonomous(ctx: RunCtx): Promise<RunResult> {
    const { taskId, agent, virtualChatId, orch, onDelta } = ctx;
    const maxRounds = agent.maxTotalRounds ?? DEFAULT_MAX_TOTAL_ROUNDS;
    const maxWallMs = agent.maxWallClockMs ?? DEFAULT_MAX_WALL_CLOCK_MS;
    const startWall = opts.registry.getTask(taskId)?.startedAt ?? Date.now();
    const doneCount = (t: AgentTask | undefined): number =>
      t?.plan ? t.plan.steps.filter((s) => s.status === 'done').length : 0;

    let lastText = '';
    let conversationId = opts.registry.getTask(taskId)?.conversationId ?? 0;
    let roundsUsed = opts.registry.getTask(taskId)?.roundsUsed ?? 0;
    let prevDone = -1;
    let stall = 0;

    const finalizeDone = (text: string): RunResult => {
      opts.registry.updateTask(taskId, {
        status: 'done',
        result: text,
        finishedAt: Date.now(),
        liveText: null, // clear the transient streaming buffer on completion
        ...(conversationId ? { conversationId } : {}),
      });
      notifyTaskDone(taskId, agent);
      emit(taskId, { type: 'done', ok: true });
      return { ok: true, text, conversationId };
    };

    for (;;) {
      const fresh = opts.registry.getTask(taskId);
      if (!fresh || fresh.status === 'cancelled') {
        return { ok: false, text: lastText, error: AGENT_TASK_CANCELLED_MESSAGE, conversationId };
      }
      // Cooperative pause: stop the loop but leave all state checkpointed so a
      // later resume continues from here rather than from the prompt.
      if (fresh.status === 'paused') {
        log.info('autonomous run paused between steps', { taskId, roundsUsed });
        return { ok: false, text: lastText, error: 'paused', conversationId };
      }
      if (fresh.result !== null) return finalizeDone(fresh.result); // explicit finish
      if (allStepsDone(fresh.plan)) break; // plan complete -> finalize
      if (roundsUsed >= maxRounds) break; // round budget
      if (Date.now() - startWall >= maxWallMs) break; // wall-clock budget
      if (stall >= AUTONOMOUS_STALL_LIMIT) break; // model stalled

      const steer = fresh.steerQueue;
      if (steer.length > 0) opts.registry.updateTask(taskId, { steerQueue: [] });

      emit(taskId, { type: 'phase', phase: roundsUsed === 0 ? 'planning' : 'working' });
      // Light up the step about to be worked so the run view shows a live cursor
      // (the model can't set 'active' itself — update_plan only takes titles).
      // complete_step then flips it to 'done'. No-op on turn 0 (no plan yet).
      if (fresh.plan) {
        const activated = markActive(fresh.plan);
        if (activated && activated !== fresh.plan) {
          opts.registry.updateTask(taskId, { plan: activated });
          emit(taskId, { type: 'plan', plan: activated });
        }
      }
      // Turn 0 starts from the goal; later turns continue the plan. Either way,
      // any pending steer must be folded in (a steer queued before the run
      // started would otherwise be drained and lost on turn 0).
      let text: string;
      if (roundsUsed === 0) {
        text = fresh.prompt;
        if (steer.length > 0) {
          text += `\n\nAdditional guidance from the user:\n${steer.map((s) => `- ${s}`).join('\n')}`;
        }
      } else {
        text = continuationPrompt(fresh, steer);
      }

      let turn: TurnResult;
      try {
        turn = await driveTurn(
          orch,
          virtualChatId,
          text,
          fresh.thinkMode,
          taskId,
          onDelta,
          roundsUsed === 0 ? ctx.images : undefined,
        );
      } catch (e) {
        if (opts.registry.getTask(taskId)?.status === 'cancelled') {
          return {
            ok: false,
            text: lastText,
            error: AGENT_TASK_CANCELLED_MESSAGE,
            conversationId,
          };
        }
        const msg = e instanceof Error ? e.message : String(e);
        log.warn('autonomous turn threw', { taskId, agent: agent.name, error: msg });
        opts.registry.updateTask(taskId, { status: 'error', error: msg, finishedAt: Date.now() });
        emit(taskId, { type: 'done', ok: false });
        return { ok: false, text: lastText, error: msg, conversationId };
      }

      roundsUsed += 1;
      if (turn.finalText) lastText = turn.finalText;
      else if (turn.buffer) lastText = turn.buffer;
      if (turn.conversationId) conversationId = turn.conversationId;

      const after = opts.registry.getTask(taskId);
      const dc = doneCount(after);
      const finished = after?.result != null;
      // Progress is a completed step or an explicit finish — NOT a re-authored
      // plan. Measuring against the done-count (rather than the plan JSON, which
      // a model can perturb every turn by re-wording its steps) stops a run that
      // keeps re-planning without ever completing anything from defeating the
      // stall guard and grinding to the round/wall-clock budget. The trade-off:
      // a single step that legitimately spans more than AUTONOMOUS_STALL_LIMIT
      // tool turns without a complete_step will trip the guard — acceptable, and
      // in line with the loop contract ("complete a step each turn").
      stall = finished || dc > prevDone ? 0 : stall + 1;
      prevDone = dc;

      // Checkpoint: everything needed to resume from here after a restart.
      opts.registry.updateTask(taskId, {
        roundsUsed,
        stepCursor: dc,
        checkpointAt: Date.now(),
        ...(conversationId ? { conversationId } : {}),
      });
      if (after?.plan) emit(taskId, { type: 'plan', plan: after.plan });
      emit(taskId, {
        type: 'budget',
        roundsUsed,
        maxRounds,
        wallMs: Date.now() - startWall,
        maxWallMs,
      });

      const errored = orch.lastError(virtualChatId);
      if (errored) {
        opts.registry.updateTask(taskId, {
          status: 'error',
          error: errored,
          finishedAt: Date.now(),
          ...(conversationId ? { conversationId } : {}),
        });
        emit(taskId, { type: 'done', ok: false });
        return { ok: false, text: lastText, error: errored, conversationId };
      }
      if (finished) return finalizeDone(after!.result!);
    }

    // Stopped without an explicit finish (plan done / budget / stall). One last
    // turn to produce a clean summary; the model usually calls finish here.
    if (opts.registry.getTask(taskId)?.status === 'cancelled') {
      return { ok: false, text: lastText, error: AGENT_TASK_CANCELLED_MESSAGE, conversationId };
    }
    emit(taskId, { type: 'phase', phase: 'finalizing' });
    try {
      const thinkMode = opts.registry.getTask(taskId)?.thinkMode ?? null;
      const turn = await driveTurn(
        orch,
        virtualChatId,
        FINALIZE_PROMPT,
        thinkMode,
        taskId,
        onDelta,
      );
      if (turn.conversationId) conversationId = turn.conversationId;
      const after = opts.registry.getTask(taskId);
      const summary =
        after?.result != null && after.result !== ''
          ? after.result
          : (turn.finalText ?? turn.buffer ?? lastText);
      return finalizeDone(summary || lastText || 'Task ended without a final summary.');
    } catch {
      return finalizeDone(lastText || 'Task ended without a final summary.');
    }
  }

  async function runTask(
    taskId: number,
    runOpts: { onDelta?: (delta: string) => void } = {},
  ): Promise<RunResult> {
    const task = opts.registry.getTask(taskId);
    if (!task) throw new Error(`agent task ${taskId} not found`);
    if (task.status === 'cancelled') {
      return { ok: false, text: '', error: AGENT_TASK_CANCELLED_MESSAGE, conversationId: 0 };
    }
    const agent = opts.registry.get(task.agentId);
    if (!agent) throw new Error(`agent ${task.agentId} for task ${taskId} not found`);

    const virtualChatId = AGENT_CHAT_ID_BASE + task.id;
    opts.registry.updateTask(task.id, {
      status: 'running',
      // Preserve the original start on resume so the wall-clock budget is honest.
      startedAt: task.startedAt ?? Date.now(),
      virtualChatId,
    });

    // A grant ceiling means a one-off orchestrator (different tool view than the
    // cached per-agent one); tear it down after the run.
    const ephemeral = task.toolAllowlistOverride !== null;
    const orch = ephemeral
      ? buildOrchestrator(agent, task.toolAllowlistOverride)
      : orchestratorFor(agent);
    active.set(task.id, { orch, virtualChatId });

    // Image attachments → the first turn, but only if the agent's model is
    // multimodal. The upload surface already gates this; re-checking here means
    // an attachment can never reach a text-only model (which would error the
    // turn) even via a re-pointed agent or a direct enqueue.
    let images: string[] | undefined;
    if (opts.attachmentsDir) {
      const imgs = loadImageAttachmentsBase64(opts.registry, opts.attachmentsDir, task.id);
      if (imgs.length > 0) {
        const model = opts.llm.resolveModel(agent.profile);
        const ok = opts.llm.supportsVision ? await opts.llm.supportsVision(model) : false;
        if (ok) images = imgs;
        else
          log.warn('task has image attachments but the agent model is not multimodal; skipping', {
            taskId,
            agent: agent.name,
            model,
            images: imgs.length,
          });
      }
    }

    const ctx: RunCtx = {
      taskId,
      agent,
      virtualChatId,
      orch,
      ...(runOpts.onDelta ? { onDelta: runOpts.onDelta } : {}),
      ...(images ? { images } : {}),
    };
    try {
      return agent.mode === 'autonomous' ? await runAutonomous(ctx) : await runSingle(ctx);
    } finally {
      active.delete(task.id);
      if (ephemeral) await orch.shutdown();
    }
  }

  function cancelTask(taskId: number): boolean {
    const task = opts.registry.getTask(taskId);
    if (!task) return false;
    if (task.status === 'done' || task.status === 'error' || task.status === 'paused') return false;
    if (task.status !== 'cancelled') {
      opts.registry.updateTask(taskId, {
        status: 'cancelled',
        error: AGENT_TASK_CANCELLED_MESSAGE,
        finishedAt: Date.now(),
      });
    }
    const hit = active.get(taskId);
    if (hit) {
      hit.orch.stop(hit.virtualChatId);
      return true;
    }
    return task.status === 'queued' || task.status === 'running' || task.status === 'cancelled';
  }

  // -- direct chat (panel DMs) -----------------------------------------------
  const dmActive = new Set<number>();

  async function chat(
    agentId: number,
    text: string,
    chatOpts: AgentChatOptions = {},
  ): Promise<AgentChatResult> {
    const agent = opts.registry.get(agentId);
    if (!agent) return { ok: false, text: '', error: `agent ${agentId} not found` };
    if (dmActive.has(agentId)) {
      return { ok: false, text: '', error: 'agent is already replying' };
    }
    dmActive.add(agentId);
    const chatId = agentDmChatId(agentId);
    const orch = dmOrchestratorFor(agent);
    let buffer = '';
    let finalText: string | undefined;
    try {
      await orch.handleUserMessage({
        chatId,
        userId: opts.ownerUserId,
        text,
        ...(chatOpts.thinkMode && chatOpts.thinkMode !== 'auto'
          ? { thinkMode: chatOpts.thinkMode }
          : {}),
        send: (chunk: ReplyChunk) => {
          if (chunk.thinking) chatOpts.onThinking?.(chunk.thinking);
          if (chunk.delta) {
            buffer += chunk.delta;
            chatOpts.onDelta?.(chunk.delta);
          }
          if (chunk.done) {
            if (chunk.meta?.afterTurn) finalText = chunk.meta.afterTurn.assistantText;
            else if (typeof chunk.replace === 'string') finalText = chunk.replace;
          }
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warn('agent DM turn threw', { agent: agent.name, error: msg });
      return { ok: false, text: buffer, error: msg };
    } finally {
      dmActive.delete(agentId);
    }
    const errored = orch.lastError(chatId);
    const out = finalText ?? buffer;
    return errored ? { ok: false, text: out, error: errored } : { ok: true, text: out };
  }

  function stopChat(agentId: number): boolean {
    const agent = opts.registry.get(agentId);
    if (!agent) return false;
    return dmOrchestratorFor(agent).stop(agentDmChatId(agentId));
  }

  function clearChat(agentId: number): void {
    stopChat(agentId);
    const chatId = agentDmChatId(agentId);
    // Messages cascade with their conversations (foreign_keys is ON); dropping
    // the telegram_chats pointer makes the next turn start a fresh conversation.
    opts.db.prepare(`DELETE FROM conversations WHERE telegram_chat_id = ?`).run(chatId);
    opts.db.prepare(`DELETE FROM telegram_chats WHERE chat_id = ?`).run(chatId);
  }

  function chatBusy(agentId: number): boolean {
    return dmActive.has(agentId);
  }

  async function shutdown(): Promise<void> {
    for (const [taskId] of active) cancelTask(taskId);
    await Promise.all(
      [...cache.values(), ...dmCache.values()].map((c) => c.orch.shutdown()),
    );
    cache.clear();
    dmCache.clear();
    active.clear();
  }

  return { runTask, cancelTask, subscribe, chat, stopChat, clearChat, chatBusy, shutdown };
}
