// Agents + workflows routes: CRUD, dispatch/enqueue, task control, schedules,
// approvals, and the authored-workflow DAG.
//
// In-process the panel uses the daemon's live agent registry and pokes the
// queue after enqueue so work starts immediately (no poll wait) — but the
// daemon stays the single executor, so the resource governor is never
// contended. The live run-view SSE (/api/agents/tasks/:id/stream) subscribes
// to the runtime's event bus instead of polling checkpointed DB state.

import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join, normalize } from 'node:path';
import { ensurePrivateDir } from '../../cli/config-store.js';
import {
  AGENT_TASK_CANCELLED_MESSAGE,
  agentDmChatId,
  type AgentExecutionMode,
  type CreateAgentInput,
} from '../../core/agents.js';
import type { ToolContext, ToolHandler } from '../../core/tools.js';
import { createAgentApprovalStore } from '../../core/agent-approvals.js';
import { ingestStagedDir } from '../../core/agent-attachments.js';
import { createAgentScheduleStore } from '../../core/agent-schedules.js';
import {
  createWorkflowRegistry,
  type WorkflowGraph,
  type WorkflowRunStatus,
} from '../../core/workflows.js';
import type { ProfileName, ThinkMode } from '../../core/llm.js';
import { readJson, readRawBody, sendJson, sse, writeSseHead } from '../http.js';
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

// Matches the Telegram adapter / panel chat confirm timeout: an unanswered
// confirm-tier prompt in an agent DM fails closed after this long.
const DM_CONFIRM_TIMEOUT_MS = 2 * 60_000;

export function createAgentRoutes(deps: PanelDeps): RouteModule {
  const reg = deps.agentRegistry;
  const attachmentsDir = join(deps.home, 'agent-attachments');

  // Confirm prompts parked by in-flight DM turns, keyed by id; resolved by
  // POST /api/agents/chat/confirm or failed closed on timeout/disconnect.
  const pendingDmConfirms = new Map<string, (ok: boolean) => void>();

  // Stream one DM turn with an agent over SSE. Mirrors the main panel chat
  // (routes/chat.ts) minus intercepts/instant responses — a DM speaks to one
  // persona, not the shared assistant pipeline.
  async function streamAgentChat(
    req: IncomingMessage,
    res: ServerResponse,
    agentId: number,
  ): Promise<void> {
    const agent = reg.get(agentId);
    if (!agent) {
      sendJson(res, 404, { error: 'agent not found' });
      return;
    }
    const body = await readJson<{ text?: string; thinkMode?: string }>(req);
    const text = String(body.text ?? '').trim();
    if (!text) {
      sendJson(res, 400, { error: 'empty message' });
      return;
    }
    if (deps.agentRuntime.chatBusy(agentId)) {
      sendJson(res, 409, { error: 'agent is already replying' });
      return;
    }
    const thinkMode = THINK_MODES.includes(body.thinkMode as ThinkMode)
      ? (body.thinkMode as ThinkMode)
      : 'auto';
    const dmChatId = agentDmChatId(agentId);

    writeSseHead(res);
    const send = (event: string, data: unknown): void => sse(res, event, data);
    let closed = false;

    // Inline confirm renderer for this DM turn — the attended path the daemon's
    // confirm router consults for the DM chat-id band (fail-closed otherwise).
    const confirmFn = (
      handler: ToolHandler,
      args: Record<string, unknown>,
      ctx: ToolContext,
    ): Promise<boolean> => {
      if (closed) return Promise.resolve(false);
      const id = randomUUID();
      let preview: string;
      try {
        preview = handler.confirmPrompt ? handler.confirmPrompt(args) : `Run ${handler.name}?`;
      } catch {
        preview = `Run ${handler.name}?`;
      }
      send('confirm', { id, prompt: preview, tool: handler.name });
      return new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (ok: boolean): void => {
          if (settled) return;
          settled = true;
          pendingDmConfirms.delete(id);
          clearTimeout(timer);
          ctx.signal?.removeEventListener('abort', onAbort);
          resolve(ok);
        };
        const onAbort = (): void => finish(false);
        const timer = setTimeout(() => finish(false), DM_CONFIRM_TIMEOUT_MS);
        timer.unref?.();
        ctx.signal?.addEventListener('abort', onAbort, { once: true });
        pendingDmConfirms.set(id, finish);
      });
    };
    deps.confirmBus.register(dmChatId, confirmFn);

    req.on('close', () => {
      closed = true;
      deps.agentRuntime.stopChat(agentId);
      // Fail closed: never leave a confirm-tier tool waiting on a dead stream.
      for (const finish of [...pendingDmConfirms.values()]) finish(false);
    });

    try {
      const result = await deps.agentRuntime.chat(agentId, text, {
        thinkMode,
        onDelta: (delta) => {
          if (!closed) send('delta', { delta });
        },
        onThinking: (thinking) => {
          if (!closed) send('thinking', { thinking });
        },
      });
      if (result.ok) send('done', { text: result.text });
      else send('error', { message: result.error ?? 'turn failed', text: result.text });
    } catch (e) {
      send('error', { message: e instanceof Error ? e.message : String(e) });
    } finally {
      deps.confirmBus.unregister(dmChatId, confirmFn);
      for (const finish of [...pendingDmConfirms.values()]) finish(false);
      res.end();
    }
  }

  // The rendered DM history: user/assistant rows across every conversation on
  // the agent's DM chat id, oldest first (capped to the most recent 200).
  function dmHistory(agentId: number): Array<{ role: string; content: string; createdAt: number }> {
    return (
      deps.db
        .prepare(
          `SELECT m.role AS role, m.content AS content, m.created_at AS createdAt
             FROM messages m
             JOIN conversations c ON m.conversation_id = c.id
            WHERE c.telegram_chat_id = ? AND m.role IN ('user', 'assistant')
            ORDER BY m.id DESC LIMIT 200`,
        )
        .all(agentDmChatId(agentId)) as Array<{ role: string; content: string; createdAt: number }>
    ).reverse();
  }

  // Everything the run view renders for one task: the row, its conversation
  // transcript, sub-agent children, and saved artifacts.
  function taskSnapshot(id: number) {
    const task = reg.getTask(id);
    if (!task) return null;
    const transcript = task.conversationId
      ? (deps.db
          .prepare(`SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id`)
          .all(task.conversationId) as Array<{ role: string; content: string }>)
      : [];
    const children = reg
      .listTasks({ parentId: task.id })
      .map((c) => ({ id: c.id, agentId: c.agentId, status: c.status, prompt: c.prompt }));
    return { task, transcript, children, artifacts: reg.listArtifacts(id) };
  }

  // Live run view. In-process we get real runtime events, so snapshots are
  // pushed on activity instead of Gurney's 1s DB poll. A slow sweep backstops
  // row mutations that emit no event (cancel/pause written from another
  // surface). Frames are unnamed: the browser reads this stream through native
  // EventSource.onmessage, which never fires for named events.
  function streamTask(req: IncomingMessage, res: ServerResponse, id: number): void {
    writeSseHead(res);
    let lastSig = '';
    let closed = false;
    let coalesce: ReturnType<typeof setTimeout> | null = null;
    const finish = (): void => {
      if (closed) return;
      closed = true;
      unsubscribe();
      clearInterval(sweep);
      if (coalesce) clearTimeout(coalesce);
      try {
        res.end();
      } catch {
        /* already closed */
      }
    };
    const push = (): void => {
      if (closed) return;
      const snap = taskSnapshot(id);
      if (!snap) {
        sse(res, null, { type: 'gone' });
        finish();
        return;
      }
      // Only push when something the UI cares about actually moved.
      const sig = JSON.stringify({
        s: snap.task.status,
        r: snap.task.roundsUsed,
        c: snap.task.stepCursor,
        p: snap.task.plan,
        res: snap.task.result,
        m: snap.transcript.length,
        a: snap.artifacts.length,
        lt: snap.task.liveText,
        ch: snap.children.map((ch) => `${ch.id}:${ch.status}`).join(','),
      });
      if (sig !== lastSig) {
        lastSig = sig;
        sse(res, null, { type: 'snapshot', ...snap });
      }
      if (['done', 'error', 'cancelled'].includes(snap.task.status)) finish();
    };
    // Deltas arrive per model chunk; coalesce so a fast stream doesn't
    // serialize a full snapshot per token.
    const pushSoon = (): void => {
      if (coalesce || closed) return;
      coalesce = setTimeout(() => {
        coalesce = null;
        push();
      }, 250);
    };
    const unsubscribe = deps.agentRuntime.subscribe(id, (e) => {
      if (e.type === 'delta') pushSoon();
      else push();
    });
    const sweep = setInterval(push, 2500);
    sweep.unref?.();
    req.on('close', finish);
    push();
  }

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
      const existing = reg.get(id);
      if (!existing) {
        sendJson(res, 404, { error: 'not found' });
        return true;
      }
      // Module-owned agents are managed by their module's manifest; the loader
      // overwrites any panel edit on the next reload, so refuse rather than lose it.
      if (existing.origin) {
        sendJson(res, 409, { error: 'agent is provided by a module and cannot be edited here' });
        return true;
      }
      const body = await readJson<Record<string, unknown>>(req);
      const updated = reg.update(id, normalizeAgentInput(body)) ?? null;
      sendJson(res, updated ? 200 : 404, updated ? { agent: updated } : { error: 'not found' });
      return true;
    }
    if (agentIdMatch && method === 'DELETE') {
      const id = Number(agentIdMatch[1]);
      const existing = reg.get(id);
      if (!existing) {
        sendJson(res, 404, { error: 'not found' });
        return true;
      }
      // The loader resurrects a module agent on reload, so a panel delete is
      // lossy theatre — refuse it. Removing the module is the way to remove them.
      if (existing.origin) {
        sendJson(res, 409, { error: 'agent is provided by a module and cannot be deleted here' });
        return true;
      }
      const ok = reg.remove(id);
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

    // ---- Direct chat (per-agent DMs) ---------------------------------------
    const chatMatch = /^\/api\/agents\/(\d+)\/chat$/.exec(path);
    if (chatMatch && method === 'GET') {
      const id = Number(chatMatch[1]);
      if (!reg.get(id)) {
        sendJson(res, 404, { error: 'agent not found' });
        return true;
      }
      sendJson(res, 200, { messages: dmHistory(id), busy: deps.agentRuntime.chatBusy(id) });
      return true;
    }
    if (chatMatch && method === 'POST') {
      await streamAgentChat(req, res, Number(chatMatch[1]));
      return true;
    }
    const chatStopMatch = /^\/api\/agents\/(\d+)\/chat\/stop$/.exec(path);
    if (chatStopMatch && method === 'POST') {
      const stopped = deps.agentRuntime.stopChat(Number(chatStopMatch[1]));
      sendJson(res, 200, { ok: true, stopped });
      return true;
    }
    const chatClearMatch = /^\/api\/agents\/(\d+)\/chat\/clear$/.exec(path);
    if (chatClearMatch && method === 'POST') {
      const id = Number(chatClearMatch[1]);
      if (!reg.get(id)) {
        sendJson(res, 404, { error: 'agent not found' });
        return true;
      }
      deps.agentRuntime.clearChat(id);
      sendJson(res, 200, { ok: true });
      return true;
    }
    if (path === '/api/agents/chat/confirm' && method === 'POST') {
      const { id, ok } = await readJson<{ id?: string; ok?: boolean }>(req);
      const finish = id ? pendingDmConfirms.get(id) : undefined;
      if (!finish) {
        sendJson(res, 409, { ok: false, error: 'no confirmation is waiting' });
        return true;
      }
      finish(!!ok);
      sendJson(res, 200, { ok: true });
      return true;
    }

    // Per-agent bulk task controls — the chat header's Pause / Stop acting on
    // just the selected agent's work (the global *_all routes stay untouched).
    const agentTasksMatch = /^\/api\/agents\/(\d+)\/tasks\/(pause_all|resume_all|cancel_all)$/.exec(
      path,
    );
    if (agentTasksMatch && method === 'POST') {
      const agentId = Number(agentTasksMatch[1]);
      const action = agentTasksMatch[2];
      if (!reg.get(agentId)) {
        sendJson(res, 404, { error: 'agent not found' });
        return true;
      }
      let count = 0;
      if (action === 'pause_all') {
        for (const t of reg.listTasks({ agentId, status: ['queued', 'running'] })) {
          reg.updateTask(t.id, { status: 'paused', pausedUntil: null });
          count++;
        }
      } else if (action === 'resume_all') {
        for (const t of reg.listTasks({ agentId, status: 'paused' })) {
          reg.updateTask(t.id, { status: 'queued', pausedUntil: null });
          count++;
        }
        deps.agentQueue.notify();
      } else {
        for (const t of reg.listTasks({ agentId, status: ['queued', 'running', 'paused'] })) {
          // cancelTask also aborts a running task's orchestrator turn, but
          // refuses paused rows — mark those terminal directly.
          if (t.status === 'paused') {
            reg.updateTask(t.id, {
              status: 'cancelled',
              error: AGENT_TASK_CANCELLED_MESSAGE,
              finishedAt: Date.now(),
            });
          } else {
            deps.agentRuntime.cancelTask(t.id);
          }
          count++;
        }
      }
      sendJson(res, 200, { ok: true, count });
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
      const snap = taskSnapshot(Number(taskIdMatch[1]));
      if (!snap) {
        sendJson(res, 404, { error: 'not found' });
        return true;
      }
      const agent = reg.get(snap.task.agentId);
      sendJson(res, 200, {
        ...snap,
        agentName: agent?.name ?? null,
        agent: agent
          ? {
              mode: agent.mode,
              maxTotalRounds: agent.maxTotalRounds,
              maxWallClockMs: agent.maxWallClockMs,
            }
          : null,
      });
      return true;
    }
    const streamMatch = /^\/api\/agents\/tasks\/(\d+)\/stream$/.exec(path);
    if (streamMatch && method === 'GET') {
      streamTask(req, res, Number(streamMatch[1]));
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
      if (ok) {
        reg.updateTask(id, { status: 'queued', pausedUntil: null });
        // Wake the queue: a resumed task must not sit idle until some other run
        // finishes (resume_all notifies too — keep the single-task path in sync).
        deps.agentQueue.notify();
      }
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
