// Authored multi-agent workflows (n8n-style).
//
// A workflow is a design-time DAG of nodes a user wires on a canvas. Unlike
// agent delegation — where the model decides routing at run time via spawn_agent
// — a workflow is walked deterministically by code (workflow-runner.ts); the
// model only runs *inside* agent nodes. This module owns the definitions, the
// run/step-run rows, and graph validation. It is a thin DB layer with no
// execution logic, so the control panel can instantiate it the same way it does
// createAgentRegistry (via withDb) without pulling in the live runtime.

import type { DB } from '../storage/db.js';
import type { AgentDefinition, AgentRegistry, CreateAgentInput } from './agents.js';

// ---------------------------------------------------------------------------
// Graph types
// ---------------------------------------------------------------------------

export const WORKFLOW_NODE_TYPES = [
  'trigger',
  'agent',
  'tool',
  'transform',
  'condition',
  'loop',
  'output',
] as const;
export type WorkflowNodeType = (typeof WORKFLOW_NODE_TYPES)[number];

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  // Canvas position; persisted so the editor reopens where the user left it.
  pos: { x: number; y: number };
  // Per-type configuration (agentId/promptTemplate, tool/args, op/left/right,
  // template/as, items/bodyEntry, channel/template, mode). Validated lightly
  // here; the runner reads the fields it needs per node type.
  config: Record<string, unknown>;
}

export interface WorkflowEdge {
  from: string;
  to: string;
  // For a condition node's outgoing edges: 'true' | 'false'. Unset on a normal
  // edge (always live).
  branch?: string;
}

export interface WorkflowGraph {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export type WorkflowRunStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';
export type WorkflowStepStatus = 'running' | 'done' | 'error' | 'skipped';

export interface WorkflowDefinition {
  id: number;
  name: string;
  description: string;
  graph: WorkflowGraph;
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowRun {
  id: number;
  workflowId: number;
  status: WorkflowRunStatus;
  input: string | null;
  // Staging token for files/images/PDFs uploaded with the run, or null. Bytes
  // live under <attachmentsDir>/staging/<stageToken>/; the runner ingests them
  // into each agent-node task. See 0019_workflow_run_attachments.
  stageToken: string | null;
  output: string | null;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface WorkflowStepRun {
  id: number;
  runId: number;
  nodeId: string;
  nodeType: string;
  status: WorkflowStepStatus;
  output: string | null;
  error: string | null;
  agentTaskId: number | null;
  startedAt: number;
  finishedAt: number | null;
}

export interface CreateWorkflowInput {
  name: string;
  description?: string;
  graph: WorkflowGraph;
  active?: boolean;
}

export type UpdateWorkflowInput = Partial<CreateWorkflowInput>;

// ---------------------------------------------------------------------------
// Graph parsing + validation
// ---------------------------------------------------------------------------

export class WorkflowGraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowGraphError';
  }
}

// Coerce unknown JSON into a WorkflowGraph, normalising shapes but not
// asserting semantic validity (that's validateGraph). Throws only on
// structurally unusable input.
export function parseGraph(value: unknown): WorkflowGraph {
  const obj = typeof value === 'string' ? safeJson(value) : value;
  if (!obj || typeof obj !== 'object') {
    throw new WorkflowGraphError('graph must be an object');
  }
  const rawNodes = (obj as { nodes?: unknown }).nodes;
  const rawEdges = (obj as { edges?: unknown }).edges;
  if (!Array.isArray(rawNodes)) throw new WorkflowGraphError('graph.nodes must be an array');
  if (rawEdges !== undefined && !Array.isArray(rawEdges)) {
    throw new WorkflowGraphError('graph.edges must be an array');
  }
  const nodes: WorkflowNode[] = rawNodes.map((n, i) => {
    if (!n || typeof n !== 'object') throw new WorkflowGraphError(`node ${i} is not an object`);
    const r = n as Record<string, unknown>;
    const id = String(r['id'] ?? '').trim();
    const type = String(r['type'] ?? '').trim() as WorkflowNodeType;
    const posRaw = (r['pos'] ?? {}) as Record<string, unknown>;
    return {
      id,
      type,
      pos: { x: Number(posRaw['x']) || 0, y: Number(posRaw['y']) || 0 },
      config:
        r['config'] && typeof r['config'] === 'object'
          ? (r['config'] as Record<string, unknown>)
          : {},
    };
  });
  const edges: WorkflowEdge[] = (rawEdges ?? []).map((e, i) => {
    if (!e || typeof e !== 'object') throw new WorkflowGraphError(`edge ${i} is not an object`);
    const r = e as Record<string, unknown>;
    const edge: WorkflowEdge = { from: String(r['from'] ?? ''), to: String(r['to'] ?? '') };
    if (r['branch'] !== undefined && r['branch'] !== null) edge.branch = String(r['branch']);
    return edge;
  });
  return { nodes, edges };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    throw new WorkflowGraphError('graph is not valid JSON');
  }
}

// Return a list of human-readable problems with the graph. Empty == valid.
// Enforces the invariants the runner relies on so a malformed graph is rejected
// at author time rather than blowing up mid-run.
export function validateGraph(graph: WorkflowGraph): string[] {
  const errors: string[] = [];
  if (graph.nodes.length === 0) errors.push('workflow has no nodes');

  const ids = new Set<string>();
  for (const n of graph.nodes) {
    if (!n.id) errors.push('a node is missing an id');
    else if (ids.has(n.id)) errors.push(`duplicate node id '${n.id}'`);
    else ids.add(n.id);
    if (!WORKFLOW_NODE_TYPES.includes(n.type)) {
      errors.push(`node '${n.id || '?'}' has unknown type '${n.type}'`);
    }
  }

  const triggers = graph.nodes.filter((n) => n.type === 'trigger');
  if (triggers.length === 0) errors.push('workflow needs exactly one trigger node (has none)');
  else if (triggers.length > 1)
    errors.push(`workflow has ${triggers.length} trigger nodes; needs exactly one`);

  for (const e of graph.edges) {
    if (!ids.has(e.from)) errors.push(`edge references unknown source node '${e.from}'`);
    if (!ids.has(e.to)) errors.push(`edge references unknown target node '${e.to}'`);
  }

  // Cycle detection: a successful topological sort means the graph is acyclic.
  if (errors.length === 0 && hasCycle(graph)) {
    errors.push('workflow graph has a cycle; it must be a DAG');
  }
  return errors;
}

function hasCycle(graph: WorkflowGraph): boolean {
  const out = adjacency(graph);
  const state = new Map<string, 0 | 1 | 2>(); // 0=unvisited,1=in-stack,2=done
  const visit = (id: string): boolean => {
    if (state.get(id) === 1) return true;
    if (state.get(id) === 2) return false;
    state.set(id, 1);
    for (const next of out.get(id) ?? []) {
      if (visit(next)) return true;
    }
    state.set(id, 2);
    return false;
  };
  for (const n of graph.nodes) {
    if (visit(n.id)) return true;
  }
  return false;
}

export function adjacency(graph: WorkflowGraph): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const n of graph.nodes) out.set(n.id, []);
  for (const e of graph.edges) {
    if (!out.has(e.from)) out.set(e.from, []);
    out.get(e.from)!.push(e.to);
  }
  return out;
}

// Kahn topological order. Assumes the graph is acyclic (validateGraph rejects
// cycles before a run). Nodes unreachable from any root still appear (stable by
// insertion order) so the runner can mark them skipped.
export function topoOrder(graph: WorkflowGraph): string[] {
  const out = adjacency(graph);
  const indeg = new Map<string, number>();
  for (const n of graph.nodes) indeg.set(n.id, 0);
  for (const e of graph.edges) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  const queue = graph.nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id);
  const order: string[] = [];
  const seen = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(id);
    for (const next of out.get(id) ?? []) {
      indeg.set(next, (indeg.get(next) ?? 1) - 1);
      if ((indeg.get(next) ?? 0) === 0) queue.push(next);
    }
  }
  // Append any node a cycle would have starved (defensive; shouldn't happen).
  for (const n of graph.nodes) if (!seen.has(n.id)) order.push(n.id);
  return order;
}

// ---------------------------------------------------------------------------
// Row <-> object mapping
// ---------------------------------------------------------------------------

interface WorkflowRow {
  id: number;
  name: string;
  description: string;
  graph_json: string;
  active: number;
  created_at: number;
  updated_at: number;
}

function rowToWorkflow(r: WorkflowRow): WorkflowDefinition {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    graph: parseGraph(r.graph_json),
    active: r.active !== 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

interface RunRow {
  id: number;
  workflow_id: number;
  status: string;
  input_json: string | null;
  stage_token: string | null;
  output: string | null;
  error: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

function rowToRun(r: RunRow): WorkflowRun {
  return {
    id: r.id,
    workflowId: r.workflow_id,
    status: r.status as WorkflowRunStatus,
    input: r.input_json === null ? null : extractInput(r.input_json),
    stageToken: r.stage_token,
    output: r.output,
    error: r.error,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

// input_json is stored as { input: "..." }; surface the string for convenience.
function extractInput(json: string): string | null {
  try {
    const v = JSON.parse(json) as { input?: unknown };
    return v && typeof v.input === 'string' ? v.input : null;
  } catch {
    return null;
  }
}

interface StepRow {
  id: number;
  run_id: number;
  node_id: string;
  node_type: string;
  status: string;
  output: string | null;
  error: string | null;
  agent_task_id: number | null;
  started_at: number;
  finished_at: number | null;
}

function rowToStep(r: StepRow): WorkflowStepRun {
  return {
    id: r.id,
    runId: r.run_id,
    nodeId: r.node_id,
    nodeType: r.node_type,
    status: r.status as WorkflowStepStatus,
    output: r.output,
    error: r.error,
    agentTaskId: r.agent_task_id,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

// ---------------------------------------------------------------------------
// WorkflowRegistry — CRUD over workflows + runs + step runs
// ---------------------------------------------------------------------------

export interface RunFilter {
  workflowId?: number;
  status?: WorkflowRunStatus | WorkflowRunStatus[];
  limit?: number;
}

export interface WorkflowRegistry {
  create(input: CreateWorkflowInput): WorkflowDefinition;
  get(id: number): WorkflowDefinition | undefined;
  list(): WorkflowDefinition[];
  update(id: number, patch: UpdateWorkflowInput): WorkflowDefinition | undefined;
  remove(id: number): boolean;

  enqueueRun(workflowId: number, input?: string | null, stageToken?: string | null): WorkflowRun;
  // Atomically claim the oldest queued run (UPDATE ... WHERE status='queued').
  // Returns it flipped to 'running', or undefined when none are waiting. Safe
  // across processes: only one caller wins a given row.
  claimNextQueuedRun(): WorkflowRun | undefined;
  getRun(id: number): WorkflowRun | undefined;
  listRuns(filter?: RunFilter): WorkflowRun[];
  updateRun(
    id: number,
    patch: Partial<Pick<WorkflowRun, 'status' | 'output' | 'error'>> & {
      startedAt?: number;
      finishedAt?: number;
    },
  ): void;

  addStepRun(input: {
    runId: number;
    nodeId: string;
    nodeType: string;
    status?: WorkflowStepStatus;
    output?: string | null;
    error?: string | null;
    agentTaskId?: number | null;
  }): WorkflowStepRun;
  updateStepRun(
    id: number,
    patch: Partial<Pick<WorkflowStepRun, 'status' | 'output' | 'error' | 'agentTaskId'>> & {
      finishedAt?: number;
    },
  ): void;
  listStepRuns(runId: number): WorkflowStepRun[];
}

export function createWorkflowRegistry(db: DB): WorkflowRegistry {
  const insertWorkflow = db.prepare(
    `INSERT INTO workflows (name, description, graph_json, active, created_at, updated_at)
     VALUES (@name, @description, @graph_json, @active, @created_at, @updated_at)`,
  );
  const selectById = db.prepare(`SELECT * FROM workflows WHERE id = ?`);
  const selectAll = db.prepare(`SELECT * FROM workflows ORDER BY updated_at DESC`);
  const deleteById = db.prepare(`DELETE FROM workflows WHERE id = ?`);

  const insertRun = db.prepare(
    `INSERT INTO workflow_runs (workflow_id, status, input_json, stage_token, created_at)
     VALUES (@workflow_id, 'queued', @input_json, @stage_token, @created_at)`,
  );
  const selectRunById = db.prepare(`SELECT * FROM workflow_runs WHERE id = ?`);

  const insertStep = db.prepare(
    `INSERT INTO workflow_step_runs
       (run_id, node_id, node_type, status, output, error, agent_task_id, started_at)
     VALUES (@run_id, @node_id, @node_type, @status, @output, @error, @agent_task_id, @started_at)`,
  );
  const selectStepsByRun = db.prepare(
    `SELECT * FROM workflow_step_runs WHERE run_id = ? ORDER BY id`,
  );

  function get(id: number): WorkflowDefinition | undefined {
    const row = selectById.get(id) as WorkflowRow | undefined;
    return row ? rowToWorkflow(row) : undefined;
  }

  function assertValid(graph: WorkflowGraph): void {
    const errs = validateGraph(graph);
    if (errs.length) throw new WorkflowGraphError(errs.join('; '));
  }

  function create(input: CreateWorkflowInput): WorkflowDefinition {
    assertValid(input.graph);
    const now = Date.now();
    const info = insertWorkflow.run({
      name: input.name,
      description: input.description ?? '',
      graph_json: JSON.stringify(input.graph),
      active: input.active === false ? 0 : 1,
      created_at: now,
      updated_at: now,
    });
    return get(Number(info.lastInsertRowid))!;
  }

  function update(id: number, patch: UpdateWorkflowInput): WorkflowDefinition | undefined {
    const current = get(id);
    if (!current) return undefined;
    const next: WorkflowDefinition = {
      ...current,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.graph !== undefined ? { graph: patch.graph } : {}),
      ...(patch.active !== undefined ? { active: patch.active } : {}),
      updatedAt: Date.now(),
    };
    assertValid(next.graph);
    db.prepare(
      `UPDATE workflows SET name = @name, description = @description,
         graph_json = @graph_json, active = @active, updated_at = @updated_at
       WHERE id = @id`,
    ).run({
      id,
      name: next.name,
      description: next.description,
      graph_json: JSON.stringify(next.graph),
      active: next.active ? 1 : 0,
      updated_at: next.updatedAt,
    });
    return get(id);
  }

  function remove(id: number): boolean {
    return deleteById.run(id).changes > 0;
  }

  function getRun(id: number): WorkflowRun | undefined {
    const row = selectRunById.get(id) as RunRow | undefined;
    return row ? rowToRun(row) : undefined;
  }

  function enqueueRun(
    workflowId: number,
    input?: string | null,
    stageToken?: string | null,
  ): WorkflowRun {
    const info = insertRun.run({
      workflow_id: workflowId,
      input_json: input == null ? null : JSON.stringify({ input }),
      stage_token: stageToken ?? null,
      created_at: Date.now(),
    });
    return getRun(Number(info.lastInsertRowid))!;
  }

  // Atomic claim: flip exactly one queued row to running and return it. The
  // UPDATE ... WHERE id = (SELECT ... LIMIT 1) AND status='queued' guard means
  // a concurrent caller (or a second daemon) can't grab the same row.
  const claimStmt = db.prepare(
    `UPDATE workflow_runs SET status = 'running', started_at = @now
       WHERE id = (SELECT id FROM workflow_runs WHERE status = 'queued' ORDER BY id LIMIT 1)
         AND status = 'queued'
     RETURNING id`,
  );
  function claimNextQueuedRun(): WorkflowRun | undefined {
    const row = claimStmt.get({ now: Date.now() }) as { id: number } | undefined;
    return row ? getRun(row.id) : undefined;
  }

  function listRuns(filter: RunFilter = {}): WorkflowRun[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.workflowId !== undefined) {
      where.push('workflow_id = ?');
      params.push(filter.workflowId);
    }
    if (filter.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      where.push(`status IN (${statuses.map(() => '?').join(', ')})`);
      params.push(...statuses);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = filter.limit ? `LIMIT ${Math.max(1, Math.floor(filter.limit))}` : '';
    const rows = db
      .prepare(`SELECT * FROM workflow_runs ${clause} ORDER BY id DESC ${limit}`)
      .all(...params) as RunRow[];
    return rows.map(rowToRun);
  }

  function updateRun(
    id: number,
    patch: Partial<Pick<WorkflowRun, 'status' | 'output' | 'error'>> & {
      startedAt?: number;
      finishedAt?: number;
    },
  ): void {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };
    const add = (col: string, key: string, val: unknown): void => {
      sets.push(`${col} = @${key}`);
      params[key] = val;
    };
    if (patch.status !== undefined) add('status', 'status', patch.status);
    if (patch.output !== undefined) add('output', 'output', patch.output);
    if (patch.error !== undefined) add('error', 'error', patch.error);
    if (patch.startedAt !== undefined) add('started_at', 'started_at', patch.startedAt);
    if (patch.finishedAt !== undefined) add('finished_at', 'finished_at', patch.finishedAt);
    if (sets.length === 0) return;
    db.prepare(`UPDATE workflow_runs SET ${sets.join(', ')} WHERE id = @id`).run(params);
  }

  function addStepRun(input: {
    runId: number;
    nodeId: string;
    nodeType: string;
    status?: WorkflowStepStatus;
    output?: string | null;
    error?: string | null;
    agentTaskId?: number | null;
  }): WorkflowStepRun {
    const info = insertStep.run({
      run_id: input.runId,
      node_id: input.nodeId,
      node_type: input.nodeType,
      status: input.status ?? 'running',
      output: input.output ?? null,
      error: input.error ?? null,
      agent_task_id: input.agentTaskId ?? null,
      started_at: Date.now(),
    });
    const row = db
      .prepare(`SELECT * FROM workflow_step_runs WHERE id = ?`)
      .get(Number(info.lastInsertRowid)) as StepRow;
    return rowToStep(row);
  }

  function updateStepRun(
    id: number,
    patch: Partial<Pick<WorkflowStepRun, 'status' | 'output' | 'error' | 'agentTaskId'>> & {
      finishedAt?: number;
    },
  ): void {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };
    const add = (col: string, key: string, val: unknown): void => {
      sets.push(`${col} = @${key}`);
      params[key] = val;
    };
    if (patch.status !== undefined) add('status', 'status', patch.status);
    if (patch.output !== undefined) add('output', 'output', patch.output);
    if (patch.error !== undefined) add('error', 'error', patch.error);
    if (patch.agentTaskId !== undefined) add('agent_task_id', 'agent_task_id', patch.agentTaskId);
    if (patch.finishedAt !== undefined) add('finished_at', 'finished_at', patch.finishedAt);
    if (sets.length === 0) return;
    db.prepare(`UPDATE workflow_step_runs SET ${sets.join(', ')} WHERE id = @id`).run(params);
  }

  return {
    create,
    get,
    list: () => (selectAll.all() as WorkflowRow[]).map(rowToWorkflow),
    update,
    remove,
    enqueueRun,
    claimNextQueuedRun,
    getRun,
    listRuns,
    updateRun,
    addStepRun,
    updateStepRun,
    listStepRuns: (runId: number) => (selectStepsByRun.all(runId) as StepRow[]).map(rowToStep),
  };
}

// ---------------------------------------------------------------------------
// Starter workflow — a worked example for the Agents → Workflows tab
// ---------------------------------------------------------------------------

// Name of the bundled example workflow. The seed keys idempotency off the two
// agents it creates (below), so a user who deletes the workflow from the panel
// keeps it deleted across restarts — same contract as seedStarterAgents.
export const CODE_REVIEW_WORKFLOW_NAME = 'Code Review Pipeline';
const PR_REVIEWER_AGENT = 'pr-reviewer';
const CODE_AUDITOR_AGENT = 'code-auditor';

function ensureAgent(agents: AgentRegistry, input: CreateAgentInput): AgentDefinition {
  return agents.getByName(input.name) ?? agents.create(input);
}

// Seed a single, end-to-end code-review workflow (and the two agents it drives)
// on a fresh install. This is the canonical "what does the workflow engine do?"
// example: it touches every interesting node type so a new user can open it in
// the builder, see a real graph, and edit from there.
//
// It is built around the read-only filesystem tools (read_file / list_dir), so
// the agents review *real code* rather than guessing. Those tools pin to a
// review root resolved per run:
//   • files/folders dropped into the run (task attachments), or
//   • the global MODULUS_FS_ROOT the operator points at the repo.
// Drop a PR's changed files (or a diff) into the run, or set MODULUS_FS_ROOT to
// your checkout, and the agents read it directly.
//
// What it demonstrates, mapped to the three things people want a code reviewer
// to do:
//   - *Check changes*   — a `loop` node fans the autonomous `pr-reviewer` agent
//      / PRs              over each path in the run input (one per line); each
//                         iteration reads that file/dir with read_file/list_dir.
//   - *Find bugs and    — the autonomous `code-auditor` then walks the whole
//      dead code*          review root with list_dir/read_file, hunting latent
//                         bugs and unreachable/unused code.
//   - *Run on long       — both agents are `autonomous` (plan→act→reflect across
//      loops*              many rounds), and the loop iterates path-by-path, so a
//                         single trigger drives a long-running review pass. To
//                         run it on a cadence, point an agent schedule (or any
//                         cron) at this workflow's /run endpoint.
//
// A `condition` gate routes the result: blockers go to Telegram loudly, a clean
// pass goes out as an all-clear. Idempotent — no-op once pr-reviewer exists.
export function seedStarterWorkflows(workflows: WorkflowRegistry, agents: AgentRegistry): void {
  // Sentinel: if the reviewer agent already exists we've seeded before. Guarding
  // on the agent (not the workflow) means deleting the workflow sticks.
  if (agents.getByName(PR_REVIEWER_AGENT)) return;

  // The tool surface a reviewer actually needs: the read-only filesystem tools
  // to read the code under review, web search for unfamiliar APIs, and
  // codex_handoff to escalate the hard reasoning. fs-tool names are listed
  // directly (they're core tools, not from an module); the module names
  // grant every tool those modules ship.
  const reviewerTools = ['read_file', 'list_dir', 'modulus-websearch', 'modulus-codex'];

  const prReviewer = ensureAgent(agents, {
    name: PR_REVIEWER_AGENT,
    role: 'Reviews a change set / pull request for correctness, security, and style',
    systemPrompt:
      'You are PR Reviewer, an autonomous code-review agent. You review a change set: the files ' +
      'dropped into this run, or the paths you are given, inside the review root. Always read the ' +
      'code before judging it — use list_dir to see what is there and read_file to read each file; ' +
      'never invent code you have not read. Search the web for unfamiliar APIs and hand genuinely ' +
      'hard or multi-file reasoning to codex_handoff. Report findings grouped by severity using the ' +
      'exact tags BLOCKER, MAJOR, and MINOR, each with file/line context and a concrete fix. If the ' +
      'change is clean, say LGTM.',
    profile: 'reason',
    thinkMode: 'on',
    toolAllowlist: reviewerTools,
    mode: 'autonomous',
    maxToolRounds: 6,
    maxTotalRounds: 16,
    maxWallClockMs: 20 * 60_000,
  });

  const codeAuditor = ensureAgent(agents, {
    name: CODE_AUDITOR_AGENT,
    role: 'Audits a codebase for latent bugs and dead or unreachable code',
    systemPrompt:
      'You are Code Auditor, an autonomous agent that audits a codebase for latent bugs and dead ' +
      'code. Walk the review root with list_dir and read the modules with read_file, then look for ' +
      'correctness bugs, race conditions, resource leaks, and unreachable / unused / never-called ' +
      'code. Use codex_handoff for deep multi-file reasoning. Return one prioritized findings list; ' +
      'tag anything that can break production with BLOCKER.',
    profile: 'reason',
    thinkMode: 'on',
    toolAllowlist: reviewerTools,
    mode: 'autonomous',
    maxToolRounds: 8,
    maxTotalRounds: 24,
    maxWallClockMs: 30 * 60_000,
  });

  const graph: WorkflowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', pos: { x: 40, y: 200 }, config: { mode: 'manual' } },
      // Loop body is an agent node run once per path; {{item}} is the current
      // line of the run input (a file or directory relative to the review root).
      {
        id: 'reviews',
        type: 'loop',
        pos: { x: 320, y: 120 },
        config: {
          items: '{{trigger.input}}',
          body: {
            type: 'agent',
            config: {
              agentId: prReviewer.id,
              promptTemplate:
                'Review `{{item}}` in the review root. Read it with read_file (or list_dir if it is ' +
                'a directory) first, then list issues as BLOCKER/MAJOR/MINOR with line context and a ' +
                'concrete fix.',
              thinkMode: 'on',
            },
          },
        },
      },
      {
        id: 'audit',
        type: 'agent',
        pos: { x: 620, y: 120 },
        config: {
          agentId: codeAuditor.id,
          promptTemplate:
            'Per-path reviews so far:\n\n{{steps.reviews.output}}\n\nNow walk the review root with ' +
            'list_dir and read_file and audit the codebase for additional bugs and dead / unreachable ' +
            'code. Return one prioritized findings list; tag production-breaking issues BLOCKER.',
          thinkMode: 'on',
        },
      },
      {
        id: 'gate',
        type: 'condition',
        pos: { x: 920, y: 120 },
        config: { left: '{{steps.audit.output}}', op: 'contains', right: 'BLOCKER' },
      },
      {
        id: 'report',
        type: 'output',
        pos: { x: 1220, y: 40 },
        config: {
          channel: 'telegram',
          template: '🔴 Code review found blockers:\n\n{{steps.audit.output}}',
        },
      },
      {
        id: 'clear',
        type: 'output',
        pos: { x: 1220, y: 240 },
        config: {
          channel: 'telegram',
          template: '✅ Code review complete — no blockers found.\n\n{{steps.audit.output}}',
        },
      },
    ],
    edges: [
      { from: 'trigger', to: 'reviews' },
      { from: 'reviews', to: 'audit' },
      { from: 'audit', to: 'gate' },
      { from: 'gate', to: 'report', branch: 'true' },
      { from: 'gate', to: 'clear', branch: 'false' },
    ],
  };

  workflows.create({
    name: CODE_REVIEW_WORKFLOW_NAME,
    description:
      'Example: drop the changed files (or a whole folder) into the run, or set MODULUS_FS_ROOT to ' +
      'your checkout, then paste one path per line as the run input. The loop fans pr-reviewer over ' +
      'each path (reading it with read_file/list_dir), code-auditor then sweeps the whole review ' +
      'root for bugs and dead code, and the result is reported to Telegram — blockers loudly, a ' +
      'clean pass as an all-clear. Edit the agents, prompts, and branches to taste.',
    graph,
    active: true,
  });
}
