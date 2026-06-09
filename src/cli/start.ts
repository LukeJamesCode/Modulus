// `modulus start` — boot the bot.
//
// Wires together (in order):
//   1. logger (with file mirror at ~/.modulus/log/modulus.log)
//   2. SQLite + migrations (~/.modulus/modulus.db)
//   3. Ollama LLM client
//   4. tool registry
//   5. core scheduler / proactive loop (cron tick + nudge dispatcher)
//   6. extension loader — discovers + loads everything in
//      <repo>/extensions and ~/.modulus/extensions, registers their hooks
//   7. orchestrator (two queues, conversation pipeline)
//   8. Telegram adapter (long-poll)
//
// Phase 3: settings come from ~/.modulus/config.json (written by `modulus init`
// or `modulus config`). Environment variables still win, so existing
// deployments that exported TELEGRAM_BOT_TOKEN etc. don't break.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { open as openDb } from '../storage/db.js';
import { createLogger } from '../util/log.js';
import { createOllama } from '../core/llm.js';
import { createRoutedLLM } from '../core/llm-router.js';
import { profilesForTier } from './profiles.js';
import { createToolRegistry, type ToolHandler, type ToolContext } from '../core/tools.js';
import { createOrchestrator } from '../core/orchestrator.js';
import { createScheduler, type Nudge } from '../core/scheduler.js';
import { setupFollowups } from '../core/followups.js';
import { setupMemory } from '../core/memory.js';
import {
  createAgentRegistry,
  createAgentRuntime,
  filterToolRegistry,
  isAgentChatId,
  seedStarterAgents,
  AGENT_CHAT_ID_BASE,
  SPAWN_AGENT_TOOL_NAME,
  SPAWN_AGENTS_TOOL_NAME,
  REQUEST_APPROVAL_TOOL_NAME,
} from '../core/agents.js';
import { createAgentQueue } from '../core/agent-queue.js';
import { setupAgentApprovals } from '../core/agent-approvals.js';
import { setupAgentDelegation } from '../core/agent-delegation.js';
import { setupAgentPlanning } from '../core/agent-planning.js';
import { setupFilesystemTools } from '../core/fs-tools.js';
import { pinnedFilesRoot } from '../core/agent-attachments.js';
import { setupAgentSchedules } from '../core/agent-schedules.js';
import { createWorkflowRegistry, seedStarterWorkflows } from '../core/workflows.js';
import { createWorkflowRunner } from '../core/workflow-runner.js';
import type { Tier } from './profiles.js';
import {
  createExtensionLoader,
  type HostOrchestrator,
  type VoicePayload,
} from '../core/extensions.js';
import {
  collectExtensionReadiness,
  formatSetupIssuesNudge,
  setupIssuesForNudge,
} from '../core/extension-readiness.js';
import { createPrefsStore } from '../core/prefs.js';
import { createMetricsWriter } from '../core/metrics.js';
import { createTelegram } from '../adapters/telegram.js';
import { effectiveConfig, ensurePrivateDir, homeDir } from './config-store.js';
import {
  clearPid,
  isAlive,
  logFilePath,
  metricsFilePath,
  pidFilePath,
  readPid,
  tryAcquirePidLock,
} from './daemon.js';
import { createPanel, type PanelHandle } from '../panel/server.js';

const HOST_VERSION = '0.1.0';

export interface StartRunOptions {
  detach?: boolean;
  // Skip starting the in-process web panel. Used by the detached parent (the
  // child owns the panel) and by a restart that only wants the agent.
  agentOnly?: boolean;
}

function defaultExtensionRoots(home: string): string[] {
  const userDir = join(home, 'extensions');
  // First-party extensions live in <repo>/extensions in dev. Resolve relative
  // to this file, then fall back to the cwd if it doesn't exist.
  const here = dirname(fileURLToPath(import.meta.url));
  const repoExt = resolve(here, '..', '..', 'extensions');
  return [userDir, repoExt];
}

function knownAllowedChats(
  db: ReturnType<typeof openDb>,
  allowedUserIds: readonly number[],
): number[] {
  if (allowedUserIds.length === 0) return [];
  const placeholders = allowedUserIds.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT chat_id
       FROM telegram_chats
       WHERE user_id IN (${placeholders})
       ORDER BY last_seen_at DESC`,
    )
    .all(...allowedUserIds) as Array<{ chat_id: number }>;
  return rows.map((row) => row.chat_id);
}

// Parse a bounded positive integer from an env var; return undefined on
// missing/invalid so callers fall back to library defaults instead of
// silently disabling the feature.

function envInt(key: string): number | undefined {
  const raw = process.env[key]?.trim();
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
}

// How many tiny-model (non-heavy) agent tasks may run at once, by tier. The
// heavy slot is always 1 (one resident reasoning model); only tiny tasks
// parallelize, and only where there's RAM/CPU headroom to do so. A Pi stays
// strictly sequential.
function tinyAgentConcurrencyForTier(tier: Tier | undefined): number {
  switch (tier) {
    case 'heavy':
      return 3;
    case 'standard':
      return 2;
    default:
      return 1;
  }
}

export async function run(options: StartRunOptions = {}): Promise<void> {
  const home = homeDir();
  ensurePrivateDir(home);

  // If a stale pid file points at a live process, refuse to double-start.
  const existing = readPid(home);
  if (existing && isAlive(existing)) {
    throw new Error(`modulus already running (pid ${existing}). Use 'modulus stop' first.`);
  }
  if (existing) clearPid(home);

  const cfg = effectiveConfig(home);
  // Validate the config in the parent — before any fork — so a missing or
  // malformed token fails loudly here instead of crashing a detached child
  // that the parent already reported as "started in background".
  if (!cfg.telegram.token) {
    throw new Error("Telegram bot token is not set. Run 'modulus init' or set TELEGRAM_BOT_TOKEN.");
  }
  // Telegram tokens are <bot-id>:<secret> with a 30+ char secret. Catching a
  // truncated or wrong-format token here is cheaper than booting grammY,
  // failing the first long-poll, and chewing through the circuit breaker.
  if (!/^[0-9]+:[A-Za-z0-9_-]{30,}$/.test(cfg.telegram.token)) {
    throw new Error('Telegram bot token has an invalid shape.');
  }
  if (cfg.telegram.allowedIds.length === 0) {
    throw new Error(
      "No Telegram user IDs are allowlisted. Run 'modulus init' or set TELEGRAM_ALLOWED_IDS.",
    );
  }

  if (options.detach) {
    // The child runs `modulus start` in the foreground and owns the panel
    // itself (it hits the startPanel path below), so the parent must not also
    // spawn one — that would double-spawn. Forward --agent-only to the child.
    detach(home, options.agentOnly ?? false);
    return;
  }

  // Acquire the PID file as an atomic lock before the (slow) boot. This closes
  // the race where two near-simultaneous starts both pass the readPid guard
  // above and then both wire up a full daemon. We've already validated config,
  // so a lingering lock here only ever points at a real boot attempt; if that
  // boot crashes, the next start's isAlive() check reaps the dead pid.
  if (!tryAcquirePidLock(process.pid, home)) {
    throw new Error("modulus is already starting. Use 'modulus stop' first if this is stale.");
  }

  const log = createLogger({
    level: cfg.logLevel ?? 'info',
    file: logFilePath(home),
  });

  const db = openDb({ path: join(home, 'modulus.db'), log });

  // num_predict / keep_alive / num_ctx defaults scale with the configured
  // hardware tier (see profilesForTier). The base values are ATLAS's
  // production tuning for qwen3.5 family models — a num_predict cap so Ollama
  // doesn't ramble hundreds of tokens past a natural stop (real seconds on
  // CPU), and a keep_alive bumped above Ollama's 5m default so back-to-back
  // turns don't pay a cold reload. The heavy/standard tiers widen the context
  // window and prompt budget to use the RAM those machines actually have.
  const {
    profiles,
    budgetTokens,
    idleEvictionMs: tierIdleMs,
    toolResultMaxChars,
  } = profilesForTier(cfg.tier, cfg.models);

  // Optional resilience tunables. We surface these as env knobs (rather than
  // baking them into config.json) because they're operational levers an
  // operator might want to flip without touching the config file. The explicit
  // env value wins; otherwise the tier-scaled default applies (a 32 GB host
  // keeps heavy models warm far longer than a Pi).
  const idleEvictionMs = envInt('MODULUS_HEAVY_IDLE_MS') ?? tierIdleMs;
  const inferenceTimeoutMs = envInt('MODULUS_INFERENCE_TIMEOUT_MS');

  const llm = createRoutedLLM(
    createOllama({
      baseUrl: cfg.ollama.url,
      profiles,
      log,
      idleEvictionMs,
      ...(inferenceTimeoutMs !== undefined ? { inferenceTimeoutMs } : {}),
    }),
    // Routed providers inherit the same hard inference cap as the base, so a
    // hung provider can't wedge the user queue.
    inferenceTimeoutMs !== undefined ? { providerTimeoutMs: inferenceTimeoutMs } : {},
  );

  // Confirm-tier gate. The Telegram adapter (built further down) provides the
  // real Yes/No prompt; until then this fails closed so a confirm-tier tool can
  // never run unconfirmed during the startup window.
  let confirmToolCall: (
    handler: ToolHandler,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ) => Promise<boolean> = async () => false;
  const tools = createToolRegistry({
    log,
    confirm: (handler, args, ctx) => confirmToolCall(handler, args, ctx),
  });

  const prefs = createPrefsStore(db);

  // Build a placeholder telegram dispatcher for the scheduler. The Telegram
  // adapter swaps the real one in once it's constructed.
  let dispatchNudge: (nudge: Nudge) => Promise<void> = async () => {
    log.warn('nudge dispatched before Telegram adapter ready');
  };
  const scheduler = createScheduler({
    log,
    dispatch: (n) => dispatchNudge(n),
    prefs,
    db,
  });

  // Self-scheduled followups. Registers a core tool the model can call and a
  // per-minute sweep job on the scheduler. Done before extensions load so the
  // tool is in the registry by the time anything (extension or user) touches
  // it.
  const followups = setupFollowups({ db, scheduler, tools, log });

  // Hive-mind shared memory: one store every agent reads and writes. Registers
  // the remember/forget core tools here (before extensions load, same reason
  // as followups); the provider feeds recall into the main orchestrator AND
  // every per-agent orchestrator below, so the whole fleet shares one memory.
  const memory = setupMemory({ db, tools, log });
  const memoryProvider = (message: string): string | undefined => memory.renderForPrompt(message);

  const extensionsRoots = defaultExtensionRoots(home);
  const stateRoot = join(home, 'extension_state');
  ensurePrivateDir(stateRoot);

  // Voice-note sink for extensions like modulus-voice. The Telegram adapter
  // hasn't been built yet, so we install a thunk that resolves to it once
  // adapter construction finishes below.
  let sendVoiceImpl: ((chatId: number, voice: VoicePayload) => Promise<void>) | null = null;
  let notifySetupIssues: (() => Promise<void>) | null = null;
  // The orchestrator is built after the extension loader (it consumes
  // promptFragmentProvider/toolIntentFilter on the loader). Extensions that
  // call host.orchestrator therefore have to defer until first use; this
  // wrapper bridges that gap so the Host can hold a stable reference.
  let orchestratorImpl: ReturnType<typeof createOrchestrator> | null = null;
  const orchestratorBridge: HostOrchestrator = {
    handleUserMessage: async (msg) => {
      if (!orchestratorImpl) {
        log.warn('host.orchestrator called before core orchestrator ready');
        await msg.send({ delta: '', done: true });
        return;
      }
      await orchestratorImpl.handleUserMessage(msg);
    },
  };
  // Created before the loader so manifest v2 `agents` entries can sync into
  // the fleet during loadAll. Only needs the DB, so the early construction is
  // free; all the run-time machinery (runtime, queue) still wires up below.
  const agentRegistry = createAgentRegistry(db);
  const loader = createExtensionLoader({
    roots: extensionsRoots,
    stateRoot,
    db,
    llm,
    log,
    scheduler,
    tools,
    agents: agentRegistry,
    hostVersion: HOST_VERSION,
    chatId: cfg.telegram.allowedIds[0]!,
    allowedUserIds: cfg.telegram.allowedIds,
    watch: true,
    orchestrator: orchestratorBridge,
    sendVoice: async (chatId, voice) => {
      if (!sendVoiceImpl) {
        log.warn('sendVoice called before Telegram adapter ready');
        return;
      }
      await sendVoiceImpl(chatId, voice);
    },
    onDidReload: async () => {
      await notifySetupIssues?.();
    },
  });
  await loader.loadAll();

  const maxToolRounds = envInt('MODULUS_MAX_TOOL_ROUNDS');
  // The main (Telegram/panel) chat must not see the agent-only tools —
  // spawn_agent and request_approval are only meaningful inside an agent run,
  // and exposing them to the small chat model would just invite misfires.
  // Agents get them via their own filtered view.
  const chatTools = filterToolRegistry(
    tools,
    (h) =>
      h.name !== SPAWN_AGENT_TOOL_NAME &&
      h.name !== SPAWN_AGENTS_TOOL_NAME &&
      h.name !== REQUEST_APPROVAL_TOOL_NAME,
  );
  const orchestrator = createOrchestrator({
    db,
    llm,
    tools: chatTools,
    log,
    promptFragmentProvider: (filter) => loader.promptFragment(filter),
    toolIntentFilter: (message) => loader.relevantExtensions(message),
    memoryProvider,
    turnGuards: () => loader.turnGuards().map((r) => r.guard),
    budgetTokens,
    toolResultMaxChars,
    ...(cfg.models.tools ? { toolProfile: 'tools' as const } : {}),
    ...(maxToolRounds !== undefined ? { maxToolRounds } : {}),
  });
  orchestratorImpl = orchestrator;

  const ownerId = cfg.telegram.allowedIds[0]!;
  log.info('telegram owner identified', { ownerId });

  // Multi-agent engine. Personas run headlessly through their own per-agent
  // orchestrators (sharing this db/llm/tool registry); the queue governs WHEN
  // they run so two heavy reasoners never thrash the one resident model slot.
  // Crash recovery for tasks left 'running' by a previous process. A single-mode
  // task can't resume mid-turn, so it re-runs from scratch (started_at cleared).
  // An autonomous task checkpoints after every step, so we re-queue it but keep
  // its started_at, plan, and rounds_used — the loop resumes from the checkpoint
  // (durable resume) instead of replaying the whole goal.
  const requeued = db
    .prepare(
      `UPDATE agent_tasks
         SET status = 'queued',
             started_at = CASE
               WHEN agent_id IN (SELECT id FROM agents WHERE mode = 'autonomous') THEN started_at
               ELSE NULL
             END
       WHERE status = 'running'`,
    )
    .run().changes;
  if (requeued > 0) log.info('re-queued interrupted agent tasks', { count: requeued });
  // Seed a starter fleet on a fresh install (no-op once any agent exists).
  seedStarterAgents(agentRegistry);
  // Agents run unattended and may use big, slow models, so their per-inference
  // cap is far more generous than the chat default (120s). 20 min covers a 12B
  // research round on CPU; override with MODULUS_AGENT_INFERENCE_TIMEOUT_MS.
  const agentInferenceTimeoutMs = envInt('MODULUS_AGENT_INFERENCE_TIMEOUT_MS') ?? 20 * 60_000;
  // Per-task input attachments (dropped files/folders/images/PDFs) live here.
  const attachmentsDir = join(home, 'agent-attachments');
  const agentRuntime = createAgentRuntime({
    db,
    llm,
    tools,
    log,
    registry: agentRegistry,
    ownerUserId: ownerId,
    budgetTokens,
    toolResultMaxChars,
    inferenceTimeoutMs: agentInferenceTimeoutMs,
    attachmentsDir,
    memoryProvider,
    // Promote a finished task's recorded findings into shared memory, tagged
    // by the agent that learned them — the write half of the hive mind.
    onTaskDone: (task, agent) => {
      const findings = agentRegistry
        .listArtifacts(task.id)
        .filter((a) => a.name === 'finding' && typeof a.content === 'string')
        .map((a) => a.content as string);
      if (findings.length > 0) memory.promoteFindings(findings, agent.name);
    },
  });
  const agentQueue = createAgentQueue({
    registry: agentRegistry,
    runtime: agentRuntime,
    llm,
    log,
    tinyConcurrency: tinyAgentConcurrencyForTier(cfg.tier),
    // The web panel enqueues tasks from its own process; poll so the daemon —
    // the single executor — picks them up.
    pollMs: 2500,
  });
  // The spawn_agent / spawn_agents delegation tools (visible only to agents
  // that may delegate). maxParallel bounds spawn_agents' inline fan-out to the
  // tier's tiny-worker budget so a Pi never loads more small models at once
  // than its RAM allows.
  setupAgentDelegation({
    tools,
    llm,
    registry: agentRegistry,
    runtime: agentRuntime,
    queue: agentQueue,
    log,
    maxParallel: tinyAgentConcurrencyForTier(cfg.tier),
  });
  // The autonomous-loop tools (update_plan / complete_step / record_finding /
  // save_artifact / finish), visible only to agents whose mode is 'autonomous'.
  setupAgentPlanning({ tools, registry: agentRegistry, log });
  // Read-only filesystem tools (read_file / list_dir). The pinned root is
  // resolved per call: a task's dropped-in files/folders take precedence, else a
  // global MODULUS_FS_ROOT the operator set, else none (the tool says so). The
  // env-root is validated once; an invalid one is logged and treated as unset.
  const envFsRoot = process.env['MODULUS_FS_ROOT']?.trim();
  let globalRoot: string | null = null;
  if (envFsRoot) {
    const root = resolve(envFsRoot);
    if (existsSync(root)) globalRoot = root;
    else log.error('MODULUS_FS_ROOT does not exist; ignoring', { root });
  }
  setupFilesystemTools({
    tools,
    log,
    resolveRoot: (ctx: ToolContext) => {
      if (ctx.chatId !== undefined && isAgentChatId(ctx.chatId)) {
        const pinned = pinnedFilesRoot(attachmentsDir, ctx.chatId - AGENT_CHAT_ID_BASE);
        if (pinned) return pinned;
      }
      return globalRoot;
    },
  });
  setupAgentSchedules({
    db,
    scheduler,
    registry: agentRegistry,
    queue: agentQueue,
    log,
  });
  // Human-in-the-loop approvals: registers the request_approval tool and the
  // manager that parks a confirm-tier agent call until the owner answers (over
  // Telegram or the panel). The notifier is bound once the Telegram adapter
  // exists, below.
  const { manager: approvalManager } = setupAgentApprovals({
    db,
    tools,
    registry: agentRegistry,
    log,
  });
  // Pick up any queued/re-queued work now that the engine is live.
  agentQueue.notify();

  // Authored-workflow engine. Mirrors the agent queue: the panel inserts a
  // queued workflow_runs row, and this runner polls + claims + executes them.
  const workflowRegistry = createWorkflowRegistry(db);
  // Seed the bundled "Code Review Pipeline" example (and its agents) on a fresh
  // install, so the Agents → Workflows tab opens with a real, editable graph.
  seedStarterWorkflows(workflowRegistry, agentRegistry);
  // Re-queue any workflow runs left 'running' by a crash (same pattern as agent tasks).
  const requeued_wf = db
    .prepare(
      `UPDATE workflow_runs SET status = 'queued', started_at = NULL WHERE status = 'running'`,
    )
    .run().changes;
  if (requeued_wf > 0) log.info('re-queued interrupted workflow runs', { count: requeued_wf });
  const workflowRunner = createWorkflowRunner({
    registry: workflowRegistry,
    agents: agentRegistry,
    runtime: agentRuntime,
    tools,
    llm,
    log,
    ownerUserId: ownerId,
    attachmentsDir,
    pollMs: 2500,
  });
  workflowRunner.start();

  const telegram = createTelegram({
    token: cfg.telegram.token,
    allowedUserIds: cfg.telegram.allowedIds,
    ownerId,
    log,
    orchestrator,
    llm,
    tools,
    db,
    prefs,
    followups,
    agentRegistry,
    agentQueue,
    agentAttachmentsDir: attachmentsDir,
    logFilePath: logFilePath(home),
    schedulerStats: () => scheduler.stats(),
    schedulerList: () => [...scheduler.list()],
    extensions: () => collectExtensionReadiness(extensionsRoots, db),
    extensionCommands: () => loader.commands(),
    extensionIntercepts: () => loader.intercepts(),
    extensionAfterReplies: () => loader.afterReplies(),
    extensionAfterTurns: () => loader.afterTurns(),
    extensionCallbacks: () => loader.callbacks(),
    extensionVoiceMessages: () => loader.voiceMessages(),
    // Yes/No on an agent-approval prompt arrives here as a callback; resolve the
    // parked tool call. The allowlist middleware already gated the press.
    onAgentApproval: (id, approved, fromUserId) =>
      approvalManager.resolveFromTelegram(id, approved, fromUserId),
  });
  // Now that the adapter exists, push approval prompts to the owner(s) over
  // Telegram. Best-effort per chat — a send failure leaves the row pending and
  // still answerable from the panel.
  approvalManager.setNotifier(async (approval) => {
    for (const chatId of cfg.telegram.allowedIds) {
      await telegram.sendApprovalRequest(chatId, approval);
    }
  });
  // Mirror a proactive nudge to every registered chat surface other than
  // Telegram (e.g. Discord) so briefings/nudges/reminders land wherever the
  // user is. Best-effort: a surface failure must not break the Telegram path.
  const mirrorNudgeToSurfaces = async (nudge: Nudge): Promise<void> => {
    for (const surface of loader.chatSurfaces()) {
      if (!surface.deliverProactive) continue;
      try {
        await surface.deliverProactive(nudge);
      } catch (e) {
        log.warn('chat surface deliverProactive failed', {
          ext: surface.extension,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  };
  // Wire the scheduler -> Telegram nudge path, then fan out to other surfaces.
  dispatchNudge = async (nudge) => {
    await telegram.sendNudge(nudge);
    await mirrorNudgeToSurfaces(nudge);
  };
  // And the voice-note path now that the adapter exists.
  sendVoiceImpl = (chatId, voice) => telegram.sendVoice(chatId, voice);
  // Point the tool registry's confirm hook at a surface router. Extensions
  // that own a chat surface (e.g. modulus-discord) register a renderer via
  // host.chat.registerConfirm, scoped to their own chatId namespace; the
  // router picks the first matching surface for the originating chatId and
  // falls back to the Telegram adapter when nothing claims the chat. The
  // tool-engine contract is unchanged — confirm is still a single async
  // hook returning a boolean per call.
  confirmToolCall = async (handler, args, ctx) => {
    // Background agent runs are unattended, so a confirm-tier tool can't pop a
    // prompt in a live chat. Instead we park it: ask the owner over Telegram
    // (Yes/No) and in the panel, and wait for a human to decide. This is the
    // guardrail against silent autonomy in a delegated swarm — nothing risky
    // runs until someone approves it.
    if (ctx.chatId !== undefined && isAgentChatId(ctx.chatId)) {
      let preview: string;
      try {
        preview = handler.confirmPrompt ? handler.confirmPrompt(args) : `Run \`${handler.name}\`?`;
      } catch {
        preview = `Run \`${handler.name}\`?`;
      }
      return approvalManager.request({
        taskId: ctx.chatId - AGENT_CHAT_ID_BASE,
        toolName: handler.name,
        preview,
        args,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
    }
    if (ctx.chatId !== undefined) {
      for (const surface of loader.chatSurfaces()) {
        let owns = false;
        try {
          owns = surface.ownsChat(ctx.chatId);
        } catch (e) {
          log.warn('chat surface ownsChat threw — skipping', {
            ext: surface.extension,
            error: e instanceof Error ? e.message : String(e),
          });
          continue;
        }
        if (!owns) continue;
        let preview: string;
        try {
          preview = handler.confirmPrompt
            ? handler.confirmPrompt(args)
            : `Run \`${handler.name}\`?`;
        } catch {
          preview = `Run \`${handler.name}\`?`;
        }
        try {
          return await surface.confirm({
            chatId: ctx.chatId,
            toolName: handler.name,
            preview,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
        } catch (e) {
          // Fail closed on a renderer crash. A confirm-tier tool must never
          // run when its prompt couldn't be delivered.
          log.warn('chat surface confirm threw — failing closed', {
            ext: surface.extension,
            tool: handler.name,
            error: e instanceof Error ? e.message : String(e),
          });
          return false;
        }
      }
    }
    return telegram.confirmToolCall(handler, args, ctx);
  };
  let lastSetupIssueSignature = '';
  notifySetupIssues = async () => {
    const issues = setupIssuesForNudge(collectExtensionReadiness(extensionsRoots, db));
    const signature = JSON.stringify(
      issues.map((e) => [e.name, e.status, e.reasons, e.nextAction]).sort(),
    );
    if (issues.length === 0) {
      lastSetupIssueSignature = '';
      return;
    }
    if (signature === lastSetupIssueSignature) return;
    const chats = knownAllowedChats(db, cfg.telegram.allowedIds);
    if (chats.length === 0) return;
    lastSetupIssueSignature = signature;
    const text = formatSetupIssuesNudge(issues);
    for (const chatId of chats) await telegram.sendMessage(chatId, text);
    // Mirror the alert to other chat surfaces (e.g. Discord) as a nudge.
    await mirrorNudgeToSurfaces({
      chatId: ownerId,
      text,
      key: 'setup-issues',
      reason: 'Setup issues detected',
    });
  };

  await telegram.start();
  await notifySetupIssues();
  scheduler.start();

  const metricsWriter = createMetricsWriter({
    path: metricsFilePath(home),
    log,
    scheduler,
    startedAt: Date.now(),
  });
  metricsWriter.start();

  // PID file was already written as a lock at the top of run() (see
  // tryAcquirePidLock); nothing more to do here.

  // In-process web panel. It borrows the live engine (no second stack, no DB
  // polling) and serves the browser UI + token-gated API. Best-effort: a panel
  // failure must never take the agent down. Skipped with --agent-only or when
  // panel.enabled is false. A panel Restart sets this flag so shutdown re-execs
  // a fresh daemon only after the pid lock is released (no double-start race).
  let restartRequested = false;
  let panel: PanelHandle | null = null;
  if (!options.agentOnly && cfg.panel?.enabled !== false) {
    try {
      panel = await createPanel({
        db,
        log,
        home,
        config: cfg,
        extensionRoots: extensionsRoots,
        ...(process.argv[1] ? { cliEntry: process.argv[1] } : {}),
        execArgv: process.execArgv,
        onStop: () => void shutdown('panel-stop'),
        onRestart: () => {
          restartRequested = true;
          void shutdown('panel-restart');
        },
      });
      process.stdout.write(`Panel: ${panel.url}\n`);
    } catch (e) {
      log.error('web panel failed to start', {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Best-effort warm-up. `/api/tags` proves Ollama is reachable, then the
  // tiny capped chat call actually loads the configured chat model so the
  // first real user turn doesn't pay cold-start latency.
  void (async () => {
    const h = await llm.health();
    if (!h.ok) {
      log.warn('Ollama health check failed at boot');
      return;
    }
    log.info('Ollama reachable', { models: h.models.length });
    try {
      let warmedModel: string | undefined;
      for await (const chunk of llm.chat({
        profile: 'chat',
        messages: [
          { role: 'system', content: 'You are Modulus. Reply with OK.' },
          { role: 'user', content: 'warm up' },
        ],
        maxTokens: 1,
      })) {
        warmedModel = chunk.model ?? warmedModel;
        if (chunk.done) break;
      }
      log.info('chat model warmed', { model: warmedModel ?? llm.resolveModel('chat') });
    } catch (e) {
      log.warn('chat model warm-up failed', {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  })();

  const shutdown = async (signal: string): Promise<void> => {
    log.info('shutdown signal received', { signal });
    // If any of the awaited stages below hangs (extension watcher, grammY
    // long-poll drain, etc.) the process would otherwise sit forever and
    // /restart's helper would wait forever. Force-exit after a budget.
    const hardExit = setTimeout(() => {
      log.warn('shutdown took too long, forcing exit');
      process.exit(1);
    }, 8_000);
    hardExit.unref();
    // Close the panel first so its port frees immediately and an in-flight
    // browser request can't keep a handle open past the budget.
    try {
      await panel?.close();
    } catch {
      /* ignore */
    }
    try {
      metricsWriter.stop();
    } catch {
      /* ignore */
    }
    try {
      scheduler.stop();
    } catch {
      /* ignore */
    }
    try {
      workflowRunner.stop();
    } catch {
      /* ignore */
    }
    try {
      await loader.shutdown();
    } catch (e) {
      log.warn('extension loader shutdown failed', {
        error: e instanceof Error ? e.message : String(e),
      });
    }
    try {
      // Release any parked approvals first so a task waiting on one can unwind,
      // otherwise the drain would block on a tool call no one will answer now.
      approvalManager.shutdown();
      await agentQueue.drain();
      await agentRuntime.shutdown();
    } catch (e) {
      log.warn('agent engine shutdown failed', {
        error: e instanceof Error ? e.message : String(e),
      });
    }
    try {
      await telegram.stop();
    } catch (e) {
      log.warn('telegram stop failed', { error: e instanceof Error ? e.message : String(e) });
    }
    try {
      llm.stopIdleEviction();
    } catch {
      /* ignore */
    }
    try {
      await orchestrator.shutdown();
    } catch (e) {
      log.warn('orchestrator shutdown failed', {
        error: e instanceof Error ? e.message : String(e),
      });
    }
    try {
      db.close();
    } catch {
      /* ignore */
    }
    clearPid(home);
    // A panel-triggered restart re-execs a fresh daemon now that the pid lock
    // is released, so the replacement's tryAcquirePidLock can't lose to us.
    if (restartRequested) {
      try {
        const here = dirname(fileURLToPath(import.meta.url));
        const cliEntry = process.argv[1] ?? join(here, 'index.js');
        spawn(process.execPath, [...process.execArgv, cliEntry, 'start'], {
          detached: true,
          stdio: 'ignore',
          env: process.env,
        }).unref();
      } catch (e) {
        log.warn('restart re-exec failed', { error: e instanceof Error ? e.message : String(e) });
      }
    }
    clearTimeout(hardExit);
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

// Spawn ourselves as a detached child running `modulus start` (without
// --detach) and exit. The child writes its PID once it's fully wired up.
function detach(home: string, agentOnly: boolean): void {
  // Re-exec the *same* entry script this process was launched with. Hardcoding
  // ./index.js broke `src`-via-tsx runs (only index.ts exists there) and any
  // install whose bin lives elsewhere; argv[1] is always the real entrypoint.
  // Fall back to the sibling index.js for the built layout if argv[1] is absent.
  const here = dirname(fileURLToPath(import.meta.url));
  const cliEntry = process.argv[1] ?? join(here, 'index.js');
  const args = ['start', ...(agentOnly ? ['--agent-only'] : [])];
  const child = spawn(process.execPath, [...process.execArgv, cliEntry, ...args], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
  process.stdout.write(
    `modulus started in background (pid ${child.pid}). Logs: ${logFilePath(home)}\n` +
      `Stop with 'modulus stop'. Pid file: ${pidFilePath(home)}\n`,
  );
}
