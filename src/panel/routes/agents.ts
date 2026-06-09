// Agents + workflows routes: CRUD, dispatch/enqueue, task control, schedules,
// approvals, and the authored-workflow DAG.
//
// In-process the panel uses the daemon's live agent registry and pokes the
// queue after enqueue so work starts immediately (no poll wait) — but the
// daemon stays the single executor, so the resource governor is never
// contended. The live run-view SSE (/api/agents/tasks/:id/stream) is wired in
// the SSE commit via agentRuntime.subscribe; here it 404s.

import { writeFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { ensurePrivateDir } from '../../cli/config-store.js';
import {
  AGENT_TASK_CANCELLED_MESSAGE,
  type AgentExecutionMode,
  type CreateAgentInput,
} from '../../core/agents.js';
import { createAgentApprovalStore } from '../../core/agent-approvals.js';
import { ingestStagedDir } from '../../core/agent-attachments.js';
import { createAgentScheduleStore } from '../../core/agent-schedules.js';
import {
  createWorkflowRegistry,
  type WorkflowGraph,
  type WorkflowRunStatus,
} from '../../core/workflows.js';
import type { ProfileName, ThinkMode } from '../../core/llm.js';
import { readJson, readRawBody, sendJson } from '../http.js';
import type { RouteModule } from '../router.js';
import type { PanelDeps } from '../types.js';

const AGENT_PROFILES: readonly ProfileName[] = ['chat', 'reason', 'tools'];
const THINK_MODES: readonly ThinkMode[] = ['auto', 'on', 'off'];

function parseThinkMode(v: unknown): ThinkMode {
  return THINK_MODES.includes(v as ThinkMode) ? (v as ThinkMode) : 'auto';
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number.parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

// Map an untrusted JSON body from the panel into a validated CreateAgentInput.
// toolAllowlist === null means "all tools"; an array is an explicit allowlist.
function normalizeAgentInput(body: Record<string, unknown>): CreateAgentInput {
  const profile = AGENT_PROFILES.includes(body['profile'] as ProfileName)
    ? (body['profile'] as ProfileName)
    : 'chat';
  const executionMode: AgentExecutionMode =
    body['executionMode'] === 'parallel' ? 'parallel' : 'sequential';
  const allow = body['toolAllowlist'];
  const toolAllowlist: string[] | null = Array.isArray(allow)
    ? allow.map((s) => String(s).trim()).filter(Boolean)
    : null;
  const delegatableAgents = Array.isArray(body['delegatableAgents'])
    ? body['delegatableAgents'].map((s) => String(s).trim()).filter(Boolean)
    : [];
  const rawBudget = body['budgetTokens'];
  const mode = body['mode'] === 'autonomous' ? 'autonomous' : 'single';
  const rawWall = body['maxWallClockMs'];
  const rawRounds = body['maxTotalRounds'];
  return {
    name: String(body['name'] ?? '').trim(),
    role: String(body['role'] ?? '').trim(),
    systemPrompt: String(body['systemPrompt'] ?? '').trim(),
    profile,
    thinkMode: parseThinkMode(body['thinkMode']),
    toolAllowlist,
    maxToolRounds: clampInt(body['maxToolRounds'], 1, 12, 4),
    budgetTokens:
      rawBudget === null || rawBudget === undefined || rawBudget === ''
        ? null
        : clampInt(rawBudget, 256, 32768, 4096),
    executionMode,
    maxConcurrency: clampInt(body['maxConcurrency'], 1, 8, 1),
    canDelegate: !!body['canDelegate'],
    delegatableAgents,
    mode,
    maxWallClockMs:
      rawWall === null || rawWall === undefined || rawWall === ''
        ? null
        : clampInt(rawWall, 60_000, 6 * 60 * 60_000, 30 * 60_000),
    maxTotalRounds:
      rawRounds === null || rawRounds === undefined || rawRounds === ''
        ? null
        : clampInt(rawRounds, 1, 200, 30),
  };
}

function normalizeAgentScheduleInput(body: Record<string, unknown>): {
  agentIds: number[];
  prompt: string;
  nextRunAt: number;
  recurrence: 'once' | 'daily' | 'weekly' | 'monthly' | 'yearly';
} {
  const rawIds = Array.isArray(body['agentIds'])
    ? body['agentIds']
    : body['agentId'] !== undefined
      ? [body['agentId']]
      : [];
  const agentIds = rawIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0);
  const recurrence =
    body['recurrence'] === 'daily' ||
    body['recurrence'] === 'weekly' ||
    body['recurrence'] === 'monthly' ||
    body['recurrence'] === 'yearly'
      ? (body['recurrence'] as 'daily' | 'weekly' | 'monthly' | 'yearly')
      : 'once';
  return {
    agentIds,
    prompt: String(body['prompt'] ?? '').trim(),
    nextRunAt: Number(body['nextRunAt']),
    recurrence,
  };
}

export function createAgentRoutes(deps: PanelDeps): RouteModule {
  const reg = deps.agentRegistry;
  const attachmentsDir = join(deps.home, 'agent-attachments');

  return async ({ req, res, url, path, method }) => {
    // ---- Agents CRUD --------------------------------------------------------
    if (path === '/api/agents' && method === 'GET') {
      sendJson(res, 200, { agents: reg.list() });
      return true;
    }
    if (path === '/api/agents' && method === 'POST') {
      const body = await readJson<Record<string, unknown>>(req);
      if (!String(body['name'] ?? '').trim() || !String(body['systemPrompt'] ?? '').trim()) {
        sendJson(res, 400, { error: 'name and systemPrompt are required' });
        return true;
      }
      if (reg.getByName(String(body['name']).trim())) {
        sendJson(res, 409, { error: 'an agent with that name exists' });
        return true;
      }
      sendJson(res, 200, { agent: reg.create(normalizeAgentInput(body)) });
      return true;
    }

    // ---- Schedules ----------------------------------------------------------
    if (path === '/api/agents/schedules' && method === 'GET') {
      const names = new Map(reg.list().map((a) => [a.id, a.name]));
      const schedules = createAgentScheduleStore(deps.db, reg)
        .list({ limit: 80 })
        .map((s) => ({ ...s, agentNames: s.agentIds.map((id) => names.get(id) ?? `#${id}`) }));
      sendJson(res, 200, { schedules });
      return true;
    }
    if (path === '/api/agents/schedules' && method === 'POST') {
      const input = normalizeAgentScheduleInput(await readJson<Record<string, unknown>>(req));
      if (input.agentIds.length === 0) {
        sendJson(res, 400, { error: 'at least one agent is required' });
        return true;
      }
      if (!input.prompt) {
        sendJson(res, 400, { error: 'prompt is required' });
        return true;
      }
      if (!Number.isFinite(input.nextRunAt)) {
        sendJson(res, 400, { error: 'nextRunAt must be a timestamp' });
        return true;
      }
      if (input.nextRunAt <= Date.now()) {
        sendJson(res, 400, { error: 'scheduled time must be in the future' });
        return true;
      }
      try {
        const schedule = createAgentScheduleStore(deps.db, reg).create(input);
        sendJson(res, 200, { schedule });
      } catch (e) {
        sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
      }
      return true;
    }
    const scheduleIdMatch = /^\/api\/agents\/schedules\/(\d+)$/.exec(path);
    if (scheduleIdMatch && method === 'DELETE') {
      const ok = createAgentScheduleStore(deps.db, reg).remove(Number(scheduleIdMatch[1]));
      sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'not found' });
      return true;
    }

    // ---- Single agent update / delete / capabilities ------------------------
    const agentIdMatch = /^\/api\/agents\/(\d+)$/.exec(path);
    if (agentIdMatch && method === 'PUT') {
      const id = Number(agentIdMatch[1]);
      const body = await readJson<Record<string, unknown>>(req);
      const updated = reg.get(id) ? (reg.update(id, normalizeAgentInput(body)) ?? null) : null;
      sendJson(res, updated ? 200 : 404, updated ? { agent: updated } : { error: 'not found' });
      return true;
    }
    if (agentIdMatch && method === 'DELETE') {
      const ok = reg.remove(Number(agentIdMatch[1]));
      sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'not found' });
      return true;
    }
    const capMatch = /^\/api\/agents\/(\d+)\/capabilities$/.exec(path);
    if (capMatch && method === 'GET') {
      const agent = reg.get(Number(capMatch[1]));
      if (!agent) {
        sendJson(res, 404, { error: 'agent not found' });
        return true;
      }
      const model = deps.llm.resolveModel(agent.profile);
      const multimodal = deps.llm.supportsVision ? await deps.llm.supportsVision(model) : false;
      sendJson(res, 200, { multimodal, model });
      return true;
    }

    // ---- Attachment staging + dispatch --------------------------------------
    if (path === '/api/agents/attachments/stage' && method === 'POST') {
      const token = String(req.headers['x-stage-token'] ?? '');
      const rel = String(req.headers['x-filename'] ?? '');
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(token)) {
        sendJson(res, 400, { error: 'bad token' });
        return true;
      }
      const safeRel = normalize(rel).replace(/^[/\\]+/, '');
      if (!safeRel || safeRel.split(/[/\\]/).includes('..')) {
        sendJson(res, 400, { error: 'bad filename' });
        return true;
      }
      const dest = join(attachmentsDir, 'staging', token, safeRel);
      ensurePrivateDir(dirname(dest));
      writeFileSync(dest, await readRawBody(req));
      sendJson(res, 200, { ok: true });
      return true;
    }
    const dispatchMatch = /^\/api\/agents\/(\d+)\/dispatch$/.exec(path);
    if (dispatchMatch && method === 'POST') {
      const id = Number(dispatchMatch[1]);
      const body = await readJson<{ prompt?: string; thinkMode?: string; stageToken?: string }>(
        req,
      );
      const prompt = String(body.prompt ?? '').trim();
      if (!prompt) {
        sendJson(res, 400, { error: 'prompt is required' });
        return true;
      }
      const thinkOverride = THINK_MODES.includes(body.thinkMode as ThinkMode)
        ? (body.thinkMode as ThinkMode)
        : undefined;
      const agent = reg.get(id);
      if (!agent) {
        sendJson(res, 404, { error: 'agent not found' });
        return true;
      }
      const stageToken =
        typeof body.stageToken === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(body.stageToken)
          ? body.stageToken
          : undefined;
      const allowVisual =
        stageToken && deps.llm.supportsVision
          ? await deps.llm.supportsVision(deps.llm.resolveModel(agent.profile))
          : false;
      const task = reg.enqueue({
        agentId: id,
        prompt,
        ...(thinkOverride ? { thinkMode: thinkOverride } : {}),
      });
      let rejected: string[] = [];
      if (stageToken) {
        const r = await ingestStagedDir({
          registry: reg,
          baseDir: attachmentsDir,
          taskId: task.id,
          stagingDir: join(attachmentsDir, 'staging', stageToken),
          allowVisual,
        });
        rejected = r.rejected;
      }
      // Poke the queue so the daemon picks the task up now, not on the next poll.
      deps.agentQueue.notify();
      sendJson(res, 200, { task, ...(rejected.length ? { rejected } : {}) });
      return true;
    }

    // ---- Tasks --------------------------------------------------------------
    if (path === '/api/agents/tasks' && method === 'GET') {
      const names = new Map(reg.list().map((a) => [a.id, a.name]));
      const tasks = reg
        .listTasks({ limit: 60 })
        .map((t) => ({ ...t, agentName: names.get(t.agentId) ?? null }));
      sendJson(res, 200, { tasks });
      return true;
    }
    const taskIdMatch = /^\/api\/agents\/tasks\/(\d+)$/.exec(path);
    if (taskIdMatch && method === 'GET') {
      const id = Number(taskIdMatch[1]);
      const task = reg.getTask(id);
      if (!task) {
        sendJson(res, 404, { error: 'not found' });
        return true;
      }
      const agent = reg.get(task.agentId);
      const transcript = task.conversationId
        ? (deps.db
            .prepare(`SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id`)
            .all(task.conversationId) as Array<{ role: string; content: string }>)
        : [];
      const children = reg
        .listTasks({ parentId: task.id })
        .map((c) => ({ id: c.id, agentId: c.agentId, status: c.status, prompt: c.prompt }));
      sendJson(res, 200, {
        task,
        agentName: agent?.name ?? null,
        agent: agent
          ? {
              mode: agent.mode,
              maxTotalRounds: agent.maxTotalRounds,
              maxWallClockMs: agent.maxWallClockMs,
            }
          : null,
        transcript,
        children,
        artifacts: reg.listArtifacts(task.id),
      });
      return true;
    }
    const cancelMatch = /^\/api\/agents\/tasks\/(\d+)\/cancel$/.exec(path);
    if (cancelMatch && method === 'POST') {
      const id = Number(cancelMatch[1]);
      const t = reg.getTask(id);
      const ok = !!t && ['queued', 'running'].includes(t.status);
      if (ok) {
        reg.updateTask(id, {
          status: 'cancelled',
          error: AGENT_TASK_CANCELLED_MESSAGE,
          finishedAt: Date.now(),
        });
      }
      sendJson(res, ok ? 200 : 409, ok ? { ok: true } : { error: 'task is not queued or running' });
      return true;
    }
    const pauseMatch = /^\/api\/agents\/tasks\/(\d+)\/pause$/.exec(path);
    if (pauseMatch && method === 'POST') {
      const id = Number(pauseMatch[1]);
      const body = await readJson<{ until?: number | null }>(req);
      const until =
        typeof body.until === 'number' && Number.isFinite(body.until) ? body.until : null;
      const t = reg.getTask(id);
      const ok = !!t && ['queued', 'running'].includes(t.status);
      if (ok) reg.updateTask(id, { status: 'paused', pausedUntil: until });
      sendJson(res, ok ? 200 : 409, ok ? { ok: true } : { error: 'task is not queued or running' });
      return true;
    }
    const resumeMatch = /^\/api\/agents\/tasks\/(\d+)\/resume$/.exec(path);
    if (resumeMatch && method === 'POST') {
      const id = Number(resumeMatch[1]);
      const t = reg.getTask(id);
      const ok = !!t && t.status === 'paused';
      if (ok) reg.updateTask(id, { status: 'queued', pausedUntil: null });
      sendJson(res, ok ? 200 : 409, ok ? { ok: true } : { error: 'task is not paused' });
      return true;
    }
    if (path === '/api/agents/tasks/pause_all' && method === 'POST') {
      const body = await readJson<{ until?: number | null }>(req);
      const until =
        typeof body.until === 'number' && Number.isFinite(body.until) ? body.until : null;
      let count = 0;
      for (const t of reg.listTasks({ status: ['queued', 'running'] })) {
        reg.updateTask(t.id, { status: 'paused', pausedUntil: until });
        count++;
      }
      sendJson(res, 200, { ok: true, count });
      return true;
    }
    if (path === '/api/agents/tasks/resume_all' && method === 'POST') {
      let count = 0;
      for (const t of reg.listTasks({ status: 'paused' })) {
        reg.updateTask(t.id, { status: 'queued', pausedUntil: null });
        count++;
      }
      deps.agentQueue.notify();
      sendJson(res, 200, { ok: true, count });
      return true;
    }
    if (path === '/api/agents/tasks/cancel_all' && method === 'POST') {
      let count = 0;
      for (const t of reg.listTasks({ status: ['queued', 'running', 'paused'] })) {
        reg.updateTask(t.id, {
          status: 'cancelled',
          error: AGENT_TASK_CANCELLED_MESSAGE,
          finishedAt: Date.now(),
        });
        count++;
      }
      sendJson(res, 200, { ok: true, count });
      return true;
    }
    const steerMatch = /^\/api\/agents\/tasks\/(\d+)\/steer$/.exec(path);
    if (steerMatch && method === 'POST') {
      const id = Number(steerMatch[1]);
      const text = String((await readJson<{ text?: string }>(req)).text ?? '').trim();
      if (!text) {
        sendJson(res, 400, { error: 'text is required' });
        return true;
      }
      const t = reg.getTask(id);
      const ok =
        !!t && ['queued', 'running', 'paused'].includes(t.status) ? reg.pushSteer(id, text) : false;
      sendJson(res, ok ? 200 : 409, ok ? { ok: true } : { error: 'task is not steerable' });
      return true;
    }
    const artifactsMatch = /^\/api\/agents\/tasks\/(\d+)\/artifacts$/.exec(path);
    if (artifactsMatch && method === 'GET') {
      sendJson(res, 200, { artifacts: reg.listArtifacts(Number(artifactsMatch[1])) });
      return true;
    }

    // ---- Approvals ----------------------------------------------------------
    if (path === '/api/agents/approvals' && method === 'GET') {
      const store = createAgentApprovalStore(deps.db);
      sendJson(res, 200, { pending: store.listPending(), recent: store.listRecent(20) });
      return true;
    }
    const approvalMatch = /^\/api\/agents\/approvals\/(\d+)\/resolve$/.exec(path);
    if (approvalMatch && method === 'POST') {
      const id = Number(approvalMatch[1]);
      const body = await readJson<{ approved?: boolean }>(req);
      if (typeof body.approved !== 'boolean') {
        sendJson(res, 400, { error: 'approved (boolean) is required' });
        return true;
      }
      const updated = createAgentApprovalStore(deps.db).decide(id, body.approved, 'panel');
      sendJson(
        res,
        updated ? 200 : 409,
        updated ? { approval: updated } : { error: 'approval is not pending or does not exist' },
      );
      return true;
    }

    // ---- Authored workflows -------------------------------------------------
    if (path === '/api/workflows' && method === 'GET') {
      sendJson(res, 200, { workflows: createWorkflowRegistry(deps.db).list() });
      return true;
    }
    if (path === '/api/workflows' && method === 'POST') {
      const body = await readJson<Record<string, unknown>>(req);
      if (!String(body['name'] ?? '').trim()) {
        sendJson(res, 400, { error: 'name is required' });
        return true;
      }
      try {
        const workflow = createWorkflowRegistry(deps.db).create({
          name: String(body['name']).trim(),
          description: String(body['description'] ?? ''),
          graph: body['graph'] as WorkflowGraph,
          active: body['active'] !== false,
        });
        sendJson(res, 200, { workflow });
      } catch (e) {
        sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
      }
      return true;
    }
    const workflowIdMatch = /^\/api\/workflows\/(\d+)$/.exec(path);
    if (workflowIdMatch && method === 'GET') {
      const workflow = createWorkflowRegistry(deps.db).get(Number(workflowIdMatch[1]));
      sendJson(res, workflow ? 200 : 404, workflow ? { workflow } : { error: 'not found' });
      return true;
    }
    if (workflowIdMatch && method === 'PUT') {
      const id = Number(workflowIdMatch[1]);
      const body = await readJson<Record<string, unknown>>(req);
      try {
        const wreg = createWorkflowRegistry(deps.db);
        const updated = wreg.get(id)
          ? wreg.update(id, {
              ...(body['name'] !== undefined ? { name: String(body['name']).trim() } : {}),
              ...(body['description'] !== undefined
                ? { description: String(body['description']) }
                : {}),
              ...(body['graph'] !== undefined ? { graph: body['graph'] as WorkflowGraph } : {}),
              ...(body['active'] !== undefined ? { active: !!body['active'] } : {}),
            })
          : null;
        sendJson(
          res,
          updated ? 200 : 404,
          updated ? { workflow: updated } : { error: 'not found' },
        );
      } catch (e) {
        sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
      }
      return true;
    }
    if (workflowIdMatch && method === 'DELETE') {
      const ok = createWorkflowRegistry(deps.db).remove(Number(workflowIdMatch[1]));
      sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'not found' });
      return true;
    }
    const workflowRunMatch = /^\/api\/workflows\/(\d+)\/run$/.exec(path);
    if (workflowRunMatch && method === 'POST') {
      const id = Number(workflowRunMatch[1]);
      const body = await readJson<{ input?: string; stageToken?: string }>(req);
      const stageToken =
        typeof body.stageToken === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(body.stageToken)
          ? body.stageToken
          : null;
      const wreg = createWorkflowRegistry(deps.db);
      const run = wreg.get(id) ? wreg.enqueueRun(id, body.input ?? null, stageToken) : null;
      sendJson(res, run ? 200 : 404, run ? { run } : { error: 'workflow not found' });
      return true;
    }
    if (path === '/api/workflows/runs' && method === 'GET') {
      const workflowId = url.searchParams.get('workflowId');
      const status = url.searchParams.get('status');
      const limit = url.searchParams.get('limit');
      const runs = createWorkflowRegistry(deps.db).listRuns({
        ...(workflowId ? { workflowId: Number(workflowId) } : {}),
        ...(status ? { status: status as WorkflowRunStatus } : {}),
        ...(limit ? { limit: Number(limit) } : {}),
      });
      sendJson(res, 200, { runs });
      return true;
    }
    const workflowRunIdMatch = /^\/api\/workflows\/runs\/(\d+)$/.exec(path);
    if (workflowRunIdMatch && method === 'GET') {
      const id = Number(workflowRunIdMatch[1]);
      const wreg = createWorkflowRegistry(deps.db);
      const run = wreg.getRun(id);
      sendJson(
        res,
        run ? 200 : 404,
        run ? { run, steps: wreg.listStepRuns(id) } : { error: 'not found' },
      );
      return true;
    }
    const workflowCancelMatch = /^\/api\/workflows\/runs\/(\d+)\/cancel$/.exec(path);
    if (workflowCancelMatch && method === 'POST') {
      const id = Number(workflowCancelMatch[1]);
      const wreg = createWorkflowRegistry(deps.db);
      const run = wreg.getRun(id);
      const ok = !!run && ['queued', 'running'].includes(run.status);
      if (ok) {
        wreg.updateRun(id, {
          status: 'cancelled',
          error: 'cancelled by user',
          finishedAt: Date.now(),
        });
      }
      sendJson(res, ok ? 200 : 409, ok ? { ok: true } : { error: 'run is not queued or running' });
      return true;
    }

    return false;
  };
}
