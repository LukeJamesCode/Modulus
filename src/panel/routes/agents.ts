// Agents routes: CRUD, dispatch/enqueue, task control, schedules, and approvals.
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
import {
  AGENT_TEMPLATES,
  AGENT_TEMPLATE_NAME_RE,
  getTemplate,
  hireFromTemplate,
} from '../../core/agent-templates.js';
import { chooseAgentForTask } from '../../core/agent-router.js';
import type { ToolContext, ToolHandler } from '../../core/tools.js';
import { createAgentApprovalStore } from '../../core/agent-approvals.js';
import { ingestStagedDir } from '../../core/agent-attachments.js';
import type { ProfileName, ThinkMode } from '../../core/llm.js';
import { readJson, readRawBody, sendJson, sse, writeSseHead } from '../http.js';
import type { RouteModule } from '../router.js';
import type { PanelDeps } from '../types.js';
import { createConfirmRegistry } from './confirm-registry.js';
import { ownerChat } from './chat.js';

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

// Matches the Telegram adapter / panel chat confirm timeout: an unanswered
// confirm-tier prompt in an agent DM fails closed after this long.
const DM_CONFIRM_TIMEOUT_MS = 2 * 60_000;

export function createAgentRoutes(deps: PanelDeps): RouteModule {
  const reg = deps.agentRegistry;
  const attachmentsDir = join(deps.home, 'agent-attachments');

  // Confirm prompts parked by in-flight DM turns; resolved by POST
  // /api/agents/chat/confirm or failed closed on timeout/disconnect. Each DM
  // stream takes its own scope() so ending one only fails-closed its confirms.
  const confirms = createConfirmRegistry();

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
    // This DM stream's own confirm scope. Cleanup fails-closed only its
    // prompts — a concurrent DM stream for another agent keeps its own.
    const confirmScope = confirms.scope();

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
          confirmScope.remove(id);
          clearTimeout(timer);
          ctx.signal?.removeEventListener('abort', onAbort);
          resolve(ok);
        };
        const onAbort = (): void => finish(false);
        const timer = setTimeout(() => finish(false), DM_CONFIRM_TIMEOUT_MS);
        timer.unref?.();
        ctx.signal?.addEventListener('abort', onAbort, { once: true });
        confirmScope.add(id, finish);
      });
    };
    deps.confirmBus.register(dmChatId, confirmFn);

    req.on('close', () => {
      closed = true;
      deps.agentRuntime.stopChat(agentId);
      // Fail closed: never leave a confirm-tier tool waiting on a dead stream.
      // Scoped to THIS stream's confirms only.
      confirmScope.failAll();
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
      confirmScope.failAll();
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

  return async ({ req, res, path, method }) => {
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

    // ---- Channel bindings (channel→agent) -----------------------------------
    // The Channels card binds a conversation to a fleet agent so its turns run
    // as that agent's persona. ownerChatId is the Dashboard's own chat — the
    // common bind target ("chat with this agent in the browser").
    if (path === '/api/agents/bindings' && method === 'GET') {
      const owner = ownerChat(deps.db, deps.config);
      sendJson(res, 200, {
        bindings: deps.conversationRouter?.list() ?? [],
        ownerChatId: owner?.chatId ?? null,
      });
      return true;
    }
    if (path === '/api/agents/bindings' && method === 'POST') {
      if (!deps.conversationRouter) {
        sendJson(res, 503, { error: 'channel bindings are not available' });
        return true;
      }
      const body = await readJson<{ chatId?: number; agentName?: string }>(req);
      const name = String(body.agentName ?? '').trim();
      const agent = reg.getByName(name);
      if (!agent) {
        sendJson(res, 404, { error: `no agent named '${name}'` });
        return true;
      }
      const chatId =
        typeof body.chatId === 'number' ? body.chatId : ownerChat(deps.db, deps.config)?.chatId;
      if (chatId === undefined) {
        sendJson(res, 400, { error: 'no chat to bind (no owner chat configured)' });
        return true;
      }
      sendJson(res, 200, { binding: deps.conversationRouter.bind(chatId, agent.id, 'user') });
      return true;
    }
    const bindingDeleteMatch = /^\/api\/agents\/bindings\/(-?\d+)$/.exec(path);
    if (bindingDeleteMatch && method === 'DELETE') {
      if (!deps.conversationRouter) {
        sendJson(res, 503, { error: 'channel bindings are not available' });
        return true;
      }
      const ok = deps.conversationRouter.unbind(Number(bindingDeleteMatch[1]));
      sendJson(res, 200, { ok });
      return true;
    }

    // ---- Templates ("hire an agent") ----------------------------------------
    if (path === '/api/agents/templates' && method === 'GET') {
      // Enabled modules, so we can flag which recommended modules a template
      // still needs. The agent hires fine without them — this only drives the
      // "works best with <module>" hint.
      const installed = new Set(
        (
          deps.db.prepare(`SELECT name FROM module_state WHERE enabled = 1`).all() as Array<{
            name: string;
          }>
        ).map((r) => r.name),
      );
      const taken = new Set(reg.list().map((a) => a.name));
      const templates = AGENT_TEMPLATES.map((t) => {
        const missingModules = t.recommendedModules.filter((m) => !installed.has(m));
        return {
          id: t.id,
          title: t.title,
          description: t.description,
          icon: t.icon,
          recommendedModules: t.recommendedModules,
          missingModules,
          installedRecommended: missingModules.length === 0,
          // An agent already exists with this template's suggested name — the
          // one-click hire would 409, so the UI prompts for a name instead.
          alreadyHired: taken.has(t.build().name),
        };
      });
      sendJson(res, 200, { templates });
      return true;
    }
    if (path === '/api/agents/templates/hire' && method === 'POST') {
      const body = await readJson<{ id?: string; name?: string }>(req);
      const template = getTemplate(String(body.id ?? ''));
      if (!template) {
        sendJson(res, 404, { error: 'unknown template' });
        return true;
      }
      const override = String(body.name ?? '').trim();
      if (override && !AGENT_TEMPLATE_NAME_RE.test(override)) {
        sendJson(res, 400, {
          error: 'name must be lowercase letters, numbers, - or _ (2–41 chars)',
        });
        return true;
      }
      const input = hireFromTemplate(template, override || undefined);
      if (reg.getByName(input.name)) {
        sendJson(res, 409, { error: 'an agent with that name exists' });
        return true;
      }
      sendJson(res, 200, { agent: reg.create(input) });
      return true;
    }

    // Schedules + standing orders moved to the unified Routines surface
    // (routes/routines.ts) — one "Routine" object over both stores.

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

    // One-request dispatch: route server-side to the best-fitting agent, enqueue,
    // and return the chosen agent so the UI can say "Sent to <agent>". No notify
    // chat — the panel has its own live run view. `agent: null` = no fit.
    if (path === '/api/agents/dispatch-auto' && method === 'POST') {
      const prompt = String((await readJson<{ prompt?: string }>(req)).prompt ?? '').trim();
      if (!prompt) {
        sendJson(res, 400, { error: 'prompt is required' });
        return true;
      }
      const choice = await chooseAgentForTask({
        task: prompt,
        agents: reg.list(),
        llm: deps.llm,
        log: deps.log,
      });
      if (!choice) {
        sendJson(res, 200, { agent: null });
        return true;
      }
      const task = reg.enqueue({ agentId: choice.agentId, prompt });
      deps.agentQueue.notify();
      sendJson(res, 200, {
        agent: { id: choice.agentId, name: choice.agentName },
        via: choice.via,
        task,
      });
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
      const finish = id ? confirms.get(id) : undefined;
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
      // cancelTask flips the row to 'cancelled' AND aborts a running task's
      // in-flight orchestrator turn — without that abort the model keeps
      // generating on Ollama until the next cancellation checkpoint, so a
      // bare DB update left the Stop button feeling dead. (The per-agent
      // cancel_all below already routes through cancelTask.)
      if (ok) deps.agentRuntime.cancelTask(id);
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
        // Mirror the per-agent cancel_all: cancelTask aborts a running turn's
        // live model call, but refuses paused rows — mark those terminal here.
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

    return false;
  };
}
