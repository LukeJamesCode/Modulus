// `modulus start` — boot the bot.
//
// Wires together (in order):
//   1. logger (with file mirror at ~/.modulus/log/modulus.log)
//   2. SQLite + migrations (~/.modulus/modulus.db)
//   3. Ollama LLM client
//   4. tool registry
//   5. core scheduler / proactive loop (cron tick + nudge dispatcher)
//   6. module loader — discovers + loads everything in
//      <repo>/modules and ~/.modulus/modules, registers their hooks
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
import { createMemoryExtractor } from '../core/memory-extraction.js';
import {
  createAgentRegistry,
  createAgentRuntime,
  agentToolPredicate,
  filterToolRegistry,
  isAgentChatId,
  isAgentDmChatId,
  seedStarterAgents,
  AGENT_CHAT_ID_BASE,
  SPAWN_AGENT_TOOL_NAME,
  SPAWN_AGENTS_TOOL_NAME,
  REQUEST_APPROVAL_TOOL_NAME,
  type AgentDefinition,
} from '../core/agents.js';
import { createConversationRouter, type ConversationRouter } from '../core/conversation-routing.js';
import { createAgentQueue } from '../core/agent-queue.js';
import { formatTaskNotification } from '../adapters/agent-commands.js';
import { setupAgentApprovals } from '../core/agent-approvals.js';
import { setupAgentDelegation } from '../core/agent-delegation.js';
import { setupAgentEscalation, ESCALATE_TOOL_NAME } from '../core/agent-escalation.js';
import {
  setupAgentHandoff,
  setupTaskHandoff,
  HANDOFF_TOOL_NAME,
  HANDOFF_TASK_TOOL_NAME,
} from '../core/agent-handoff.js';
import { setupAgentFleetTools, FLEET_TOOL_NAMES } from '../core/agent-fleet-tools.js';
import { setupAgentPlanning } from '../core/agent-planning.js';
import { setupFilesystemTools } from '../core/fs-tools.js';
import { pinnedFilesRoot } from '../core/agent-attachments.js';
import { setupAgentSchedules } from '../core/agent-schedules.js';
import {
  setupScheduleTools,
  CREATE_SCHEDULE_TOOL_NAME,
  type SchedulingDeps,
} from '../core/schedule-tools.js';
import { hostTimeZone } from '../core/schedule-parse.js';
import { createStandingOrderStore } from '../core/standing-orders.js';
import { setupHeartbeat } from '../core/heartbeat.js';
import { setupDreaming } from '../core/dreaming.js';
import type { Tier } from './profiles.js';
import {
  createModuleLoader,
  type HostOrchestrator,
  type VoicePayload,
  type PhotoPayload,
} from '../core/modules.js';
import { createSkillLoader } from '../core/skills.js';
import { setupSkillImprove } from '../core/skill-improve.js';
import {
  setupSkillTools,
  createSkillActivation,
  USE_SKILL_TOOL_NAME,
} from '../core/skill-tools.js';
import {
  collectModuleReadiness,
  formatSetupIssuesNudge,
  setupIssuesForNudge,
} from '../core/module-readiness.js';
import { createPrefsStore } from '../core/prefs.js';
import { createMetricsWriter } from '../core/metrics.js';
import { createTelegram } from '../adapters/telegram.js';
import { createInstantResponder } from '../core/instant-responses.js';
import {
  configFileExists,
  effectiveConfig,
  ensurePrivateDir,
  homeDir,
  type ModulusConfig,
} from './config-store.js';
import { startSetupServer } from './setup-mode.js';
import { openBrowser } from './open-browser.js';
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
import { createPanelConfirmBus } from '../panel/confirm-bus.js';
import { createPairingManager } from '../panel/telegram-pairing.js';
import { HOST_VERSION } from '../core/version.js';

export interface StartRunOptions {
  detach?: boolean;
  // Skip starting the in-process web panel. Used by the detached parent (the
  // child owns the panel) and by a restart that only wants the agent.
  agentOnly?: boolean;
  // Don't auto-open the browser when entering setup mode (CI / headless).
  noOpen?: boolean;
  // Bind the panel to 0.0.0.0 for this run (Pi / headless), session-only.
  lan?: boolean;
}

// Telegram tokens are <bot-id>:<30+ char secret>. Used both to gate the full
// boot and to decide whether a fresh install drops into web-first setup.
const TOKEN_SHAPE = /^[0-9]+:[A-Za-z0-9_-]{30,}$/;

export function defaultModuleRoots(home: string): string[] {
  const userDir = join(home, 'modules');
  // First-party modules live in <repo>/modules in dev. Resolve relative
  // to this file, then fall back to the cwd if it doesn't exist.
  const here = dirname(fileURLToPath(import.meta.url));
  const repoModule = resolve(here, '..', '..', 'modules');
  return [userDir, repoModule];
}

// Skills install under ~/.modulus/skills, kept apart from modules so neither
// loader ever sees the other's folders. The repo's skills/ dir (first-party
// launch skills) is only included when it exists, so this never creates an
// empty dir in the working tree before any first-party skill ships.
export function defaultSkillRoots(home: string): string[] {
  const roots = [join(home, 'skills')];
  const here = dirname(fileURLToPath(import.meta.url));
  const repoSkills = resolve(here, '..', '..', 'skills');
  if (existsSync(repoSkills)) roots.push(repoSkills);
  return roots;
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
  // A fresh install boots into web-first setup instead of failing: we serve the
  // wizard in the browser and promote to the full daemon once it's finished.
  // Telegram is optional — a panel-only install (config.json written, no bot
  // token) is configured, and an env-only Telegram deployment counts too. A
  // HALF-set Telegram (token with no one allowlisted) is a misconfiguration, so
  // it bounces back to the wizard rather than booting a bot nobody can talk to.
  const hasToken = !!cfg.telegram.token;
  const telegramHalfSet = hasToken && cfg.telegram.allowedIds.length === 0;
  const hasTelegram = TOKEN_SHAPE.test(cfg.telegram.token) && cfg.telegram.allowedIds.length > 0;
  const configured = !telegramHalfSet && (hasTelegram || configFileExists(home));

  if (!configured) {
    if (options.detach) {
      // A detached, stdio-ignored setup server with no browser would be a trap
      // (nothing to interact with) — fall through to the foreground instead.
      process.stdout.write(
        "Modulus isn't set up yet — running setup in the foreground so you can finish in the browser.\n",
      );
    }
    // Hold the pid lock across both the setup server and the promoted daemon so
    // a second `modulus start` can't race in while the wizard is open.
    if (!tryAcquirePidLock(process.pid, home)) {
      throw new Error("modulus is already starting. Use 'modulus stop' first if this is stale.");
    }
    await runSetupAndPromote(home, options);
    return;
  }

  if (options.detach) {
    // The child runs `modulus start` in the foreground and owns the panel
    // itself, so the parent must not also spawn one — that would double-spawn.
    // Forward --agent-only to the child.
    detach(home, options.agentOnly ?? false);
    return;
  }

  // Acquire the PID file as an atomic lock before the (slow) boot. This closes
  // the race where two near-simultaneous starts both pass the readPid guard
  // above and then both wire up a full daemon. If that boot crashes, the next
  // start's isAlive() check reaps the dead pid.
  if (!tryAcquirePidLock(process.pid, home)) {
    throw new Error("modulus is already starting. Use 'modulus stop' first if this is stale.");
  }

  await bootDaemon(home, cfg, options);
}

// Boot the full daemon: engine → modules → Telegram adapter → scheduler →
// panel. Extracted verbatim from run() so setup-mode promotion can call it
// directly. The pid lock is owned by the caller (run) and held for the process
// lifetime — bootDaemon must never (re)acquire it. On a wiring throw it
// best-effort unwinds what it created (via the `cleanups` registry) so a
// promotion retry can re-bind the port / re-open the DB, then rethrows.
async function bootDaemon(
  home: string,
  cfg: ModulusConfig,
  options: StartRunOptions,
): Promise<void> {
  const log = createLogger({
    level: cfg.logLevel ?? 'info',
    file: logFilePath(home),
  });

  // Resources are registered here as they come online; on a throw before the
  // daemon is fully live we run them in reverse to release the DB handle, the
  // panel port, and the Telegram long-poll.
  const cleanups: Array<() => Promise<void> | void> = [];
  try {
    const db = openDb({ path: join(home, 'modulus.db'), log });
    cleanups.push(() => {
      db.close();
    });

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
    cleanups.push(() => scheduler.stop());

    // Self-scheduled followups. Registers a core tool the model can call and a
    // per-minute sweep job on the scheduler. Done before modules load so the
    // tool is in the registry by the time anything (module or user) touches
    // it.
    const followups = setupFollowups({ db, scheduler, tools, log });

    // Hive-mind shared memory: one store every agent reads and writes. Registers
    // the remember/forget core tools here (before modules load, same reason
    // as followups); the provider feeds recall into the main orchestrator AND
    // every per-agent orchestrator below, so the whole fleet shares one memory.
    const memory = setupMemory({ db, tools, log });
    // agentId is undefined for the main chat (global recall) and bound to the
    // running agent inside the per-agent orchestrator (global ∪ its namespace).
    const memoryProvider = (message: string, agentId?: number): string | undefined =>
      memory.renderForPrompt(message, agentId);

    // Bridges browser-chat confirm-tier prompts into the daemon's confirm router
    // (consulted below before the Telegram fallback). The panel registers per-turn
    // renderers on it; empty until a panel chat turn is live.
    const panelConfirmBus = createPanelConfirmBus();

    const modulesRoots = defaultModuleRoots(home);
    const stateRoot = join(home, 'module_state');
    ensurePrivateDir(stateRoot);

    // Voice-note sink for modules like modulus-voice. The Telegram adapter
    // hasn't been built yet, so we install a thunk that resolves to it once
    // adapter construction finishes below.
    let sendVoiceImpl: ((chatId: number, voice: VoicePayload) => Promise<void>) | null = null;
    // Proactive text + photo sinks for modules (e.g. modulus-computer-use step
    // screenshots). Same deferral as sendVoice: resolved once the adapter exists.
    let sendMessageImpl: ((chatId: number, text: string) => Promise<void>) | null = null;
    let sendPhotoImpl: ((chatId: number, photo: PhotoPayload) => Promise<void>) | null = null;
    let notifySetupIssues: (() => Promise<void>) | null = null;
    // The orchestrator is built after the module loader (it consumes
    // promptFragmentProvider/toolIntentFilter on the loader). Modules that
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
    // Channel→agent bindings (v2.0.0). Late-bound: the router is built once the
    // main orchestrator + module loader exist (below), but the registry's
    // remove/update wrappers — set here, where the registry is created — must
    // reach it so every delete/edit path cleans up its bindings. Null until then.
    let conversationRouter: ConversationRouter | null = null;
    // Deleting an agent also drops its private memory namespace (migration 0032
    // adds no FK cascade) and any channel bindings to it (migration 0034). Wrap
    // remove() once here — the same registry object is shared with the loader,
    // runtime, queue, and panel, so every delete path (panel, fleet tools)
    // inherits the cleanup.
    const removeAgentRow = agentRegistry.remove.bind(agentRegistry);
    agentRegistry.remove = (id: number): boolean => {
      const ok = removeAgentRow(id);
      if (ok) {
        memory.forgetAgent(id);
        conversationRouter?.onAgentRemoved(id);
      }
      return ok;
    };
    // Editing an agent's persona/tools must invalidate its memoized bound-chat
    // orchestrator so the next turn rebuilds with the new definition.
    const updateAgentRow = agentRegistry.update.bind(agentRegistry);
    agentRegistry.update = (id, patch) => {
      const next = updateAgentRow(id, patch);
      if (next) conversationRouter?.onAgentUpdated(id);
      return next;
    };
    const loader = createModuleLoader({
      roots: modulesRoots,
      stateRoot,
      db,
      llm,
      log,
      scheduler,
      tools,
      agents: agentRegistry,
      hostVersion: HOST_VERSION,
      // 0 = "no owner chat" (panel-only install with no Telegram allowlist).
      // Proactive nudges have nowhere to go in that case and no-op safely.
      chatId: cfg.telegram.allowedIds[0] ?? 0,
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
      sendMessage: async (chatId, text) => {
        if (!sendMessageImpl) {
          log.warn('sendMessage called before Telegram adapter ready');
          return;
        }
        await sendMessageImpl(chatId, text);
      },
      sendPhoto: async (chatId, photo) => {
        if (!sendPhotoImpl) {
          log.warn('sendPhoto called before Telegram adapter ready');
          return;
        }
        await sendPhotoImpl(chatId, photo);
      },
      onDidReload: async () => {
        await notifySetupIssues?.();
      },
    });
    cleanups.push(() => loader.shutdown());
    await loader.loadAll();

    // Declarative skills: the SAFE tier of the marketplace. The loader is a
    // pure-data sibling of the module loader — no Host, no dynamic import — so a
    // skill can never run code. It shares the agent registry (skill personas
    // sync with origin 'skill:<name>') and is held to the code-free contract at
    // load as well as install. Consumed by the orchestrator/Telegram/panel in
    // later phases; created here so skill personas exist in the fleet at boot.
    const skillRoots = defaultSkillRoots(home);
    ensurePrivateDir(skillRoots[0]!);
    const skills = createSkillLoader({
      roots: skillRoots,
      db,
      log,
      hostVersion: HOST_VERSION,
      tools,
      agents: agentRegistry,
      watch: true,
      onDidReload: async () => {
        await notifySetupIssues?.();
      },
    });
    cleanups.push(() => skills.shutdown());
    await skills.loadAll();

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
        h.name !== REQUEST_APPROVAL_TOOL_NAME &&
        // handoff_task transfers a background task to a peer — agent-run only; the
        // main chat (and bound agents, which share chatTools) escalate or use the
        // live `handoff` instead.
        h.name !== HANDOFF_TASK_TOOL_NAME,
    );
    // Declarative-skill activation: register the use_skill tool, then build the
    // orchestrator's skill surface against chatTools (the same registry the
    // orchestrator runs on, so the grant intersection matches what's permitted).
    setupSkillTools({ tools, skills, log });
    // Approval-gated self-improving skills: the propose_skill tool (registered on
    // the base registry → visible to chat AND agents) parks a proposal; the owner
    // approves on Telegram/panel and the manager commits + hot-loads it. Registered
    // after the skill loader so commit can hot-reload, and after the agent registry
    // so an agent proposer resolves to its name.
    const skillImprove = setupSkillImprove({
      db,
      tools,
      skills,
      log,
      hostVersion: HOST_VERSION,
      skillsRoot: skillRoots[0]!,
      stagingRoot: join(home, 'staging'),
      registry: agentRegistry,
    });
    const skillActivation = createSkillActivation(skills, chatTools);
    const orchestrator = createOrchestrator({
      db,
      llm,
      tools: chatTools,
      log,
      promptFragmentProvider: (filter) => loader.promptFragment(filter),
      toolIntentFilter: (message) => loader.relevantModules(message),
      memoryProvider,
      turnGuards: () => loader.turnGuards().map((r) => r.guard),
      budgetTokens,
      toolResultMaxChars,
      ...(cfg.models.tools ? { toolProfile: 'tools' as const } : {}),
      ...(maxToolRounds !== undefined ? { maxToolRounds } : {}),
      ...(skillActivation ? { skills: skillActivation } : {}),
    });
    orchestratorImpl = orchestrator;

    // Channel→agent bindings (v2.0.0). A chat bound to a fleet agent runs against
    // that agent's *interactive* persona orchestrator instead of the default
    // Modulus one. It mirrors the main orchestrator's wiring (module fragments,
    // intent filter, guards, skills, budgets) but swaps in the agent's system
    // prompt, profile, namespace-scoped memory, and a tool view narrowed to the
    // agent's allowlist ∩ chatTools (so still no agent-only control-plane tools).
    // autoRoute is off — a configured persona must not be hijacked by a global
    // auto-route the way the tiny default chat model is helped along. One
    // orchestrator per agent is memoized inside the router; each persona keeps
    // its own stable deterministic prefix for the KV cache.
    const buildBoundChatOrchestrator = (agent: AgentDefinition) => {
      // The agent's own grant (allowlist ∩ chatTools), plus the handoff tool —
      // the one chat-surface control-plane verb a bound agent always keeps, so it
      // can pass the conversation on regardless of its tool allowlist.
      const own = agentToolPredicate(agent.toolAllowlist);
      return createOrchestrator({
        db,
        llm,
        tools: filterToolRegistry(chatTools, (h) => h.name === HANDOFF_TOOL_NAME || own(h)),
        log: log.child({ boundAgent: agent.name }),
        systemPrompt: agent.systemPrompt,
        defaultProfile: agent.profile,
        toolProfile: agent.profile,
        autoRouteEnabled: false,
        promptFragmentProvider: (filter) => loader.promptFragment(filter),
        toolIntentFilter: (message) => loader.relevantModules(message),
        turnGuards: () => loader.turnGuards().map((r) => r.guard),
        memoryProvider: (m: string) => memoryProvider(m, agent.id),
        budgetTokens: agent.budgetTokens ?? budgetTokens,
        toolResultMaxChars,
        ...(agent.thinkMode !== 'auto' ? { defaultThinkMode: agent.thinkMode } : {}),
        maxToolRounds: agent.maxToolRounds,
        ...(skillActivation ? { skills: skillActivation } : {}),
      });
    };
    conversationRouter = createConversationRouter({
      db,
      registry: agentRegistry,
      log,
      defaultOrchestrator: orchestrator,
      orchestratorFactory: buildBoundChatOrchestrator,
    });
    // The handoff tool reads/writes the same binding state. Registered on the
    // base `tools` registry so it appears in chatTools (main chat) and the bound
    // factory's view; agentTools (below) excludes it so a background task can't.
    setupAgentHandoff({ tools, router: conversationRouter, registry: agentRegistry, log });

    // 0 when no one is allowlisted (panel-only install). Owner-tier tools in
    // agent runs fail closed against a 0 owner, which is the safe default.
    const ownerId = cfg.telegram.allowedIds[0] ?? 0;
    const telegramEnabled =
      TOKEN_SHAPE.test(cfg.telegram.token) && cfg.telegram.allowedIds.length > 0;
    log.info('telegram owner identified', { ownerId, telegramEnabled });

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
    // Agents see every tool except the chat-side control plane: escalation is
    // the main chat's way to hand long work to the operator, and the fleet
    // tools (dispatch/status/manage) are the main chat steering the queue —
    // an agent doing either would bypass spawn_agent's depth cap and grant
    // intersection. The mirror of chatTools, which hides the agent-only
    // delegation tools from the chat.
    const agentTools = filterToolRegistry(
      tools,
      (h) =>
        h.name !== ESCALATE_TOOL_NAME &&
        // handoff transfers a live chat-surface conversation; meaningless (and
        // refused) inside a background task run, which delegates with spawn_agent.
        h.name !== HANDOFF_TOOL_NAME &&
        !FLEET_TOOL_NAMES.includes(h.name) &&
        // create_schedule notifies a real chat; an agent run's chat id is a
        // pseudo id, so reminders are a chat-surface feature only.
        h.name !== CREATE_SCHEDULE_TOOL_NAME &&
        // use_skill is a chat-surface feature: skills advertise to the chat
        // model and widen its manifest. An agent run has its own configured
        // grant, so the skill loader stays out of it (mirrors create_schedule).
        h.name !== USE_SKILL_TOOL_NAME,
    );
    const agentRuntime = createAgentRuntime({
      db,
      llm,
      tools: agentTools,
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
        if (findings.length > 0) memory.promoteFindings(findings, agent.name, agent.id);
      },
    });
    cleanups.push(() => agentRuntime.shutdown());
    // Ping the chat that dispatched a task when it finishes. Wired to Telegram
    // once the adapter is up (below); a no-op until then.
    let sendTaskNotification: (chatId: number, text: string) => Promise<void> = async () => {};
    const agentQueue = createAgentQueue({
      registry: agentRegistry,
      runtime: agentRuntime,
      llm,
      log,
      tinyConcurrency: tinyAgentConcurrencyForTier(cfg.tier),
      // The web panel enqueues tasks from its own process; poll so the daemon —
      // the single executor — picks them up.
      pollMs: 2500,
      // Task-done notifications: on a terminal state, message the dispatching
      // chat. Only tasks that recorded a notifyChatId (Telegram /dispatch) ping;
      // the formatter returns null for non-terminal/cancelled states.
      onTaskUpdate: (task) => {
        if (task.notifyChatId == null) return;
        const agent = agentRegistry.get(task.agentId);
        const text = formatTaskNotification(task, agent?.name ?? 'agent');
        if (text) void sendTaskNotification(task.notifyChatId, text);
      },
    });
    // escalate_to_agent: the main chat's hand-off to the autonomous operator on
    // the queue. Registered on the full registry so chatTools (which only hides
    // the agent-only tools) exposes it, while agentTools above hides it from
    // agents.
    setupAgentEscalation({
      tools,
      registry: agentRegistry,
      queue: agentQueue,
      log,
    });
    // handoff_task: an agent hands its whole task to a peer on the queue and
    // stops. Registered on the full registry; agentTools exposes it to agents,
    // while chatTools (above) hides it from the main chat.
    setupTaskHandoff({ tools, registry: agentRegistry, queue: agentQueue, log });
    // The Modulus Agent's fleet controls (dispatch_agent / agent_fleet_status /
    // manage_agent_tasks). Chat-only: agentTools above hides them from agents.
    setupAgentFleetTools({
      tools,
      registry: agentRegistry,
      queue: agentQueue,
      runtime: agentRuntime,
      log,
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
        // DM chats have no task, so no pinned attachment root — global only.
        if (ctx.chatId !== undefined && isAgentChatId(ctx.chatId) && !isAgentDmChatId(ctx.chatId)) {
          const pinned = pinnedFilesRoot(attachmentsDir, ctx.chatId - AGENT_CHAT_ID_BASE);
          if (pinned) return pinned;
        }
        return globalRoot;
      },
    });
    const agentSchedules = setupAgentSchedules({
      db,
      scheduler,
      registry: agentRegistry,
      queue: agentQueue,
      log,
    });
    // Natural-language scheduling: one shared store + parser behind the
    // create_schedule tool (chat model) and the /remind · /every commands.
    const scheduling: SchedulingDeps = {
      store: agentSchedules,
      registry: agentRegistry,
      log,
      timeZone: hostTimeZone(),
      llm,
    };
    setupScheduleTools({ ...scheduling, tools });

    // Standing orders + the heartbeat that evaluates them. The heartbeat is one
    // cheap registered job (cadence from MODULUS_HEARTBEAT_CRON, default */30) —
    // a quiet beat is a single SQL read; it only escalates to an agent task or a
    // nudge when an order is actually due. Agentic orders inherit agent gating.
    const standingOrders = createStandingOrderStore(db, log);
    const heartbeatCron = process.env['MODULUS_HEARTBEAT_CRON']?.trim();
    const heartbeat = setupHeartbeat({
      scheduler,
      orders: standingOrders,
      queue: agentQueue,
      registry: agentRegistry,
      log,
      ...(heartbeatCron ? { cron: heartbeatCron } : {}),
    });
    // The "dreaming" pass: one nightly registered job (MODULUS_DREAMING_CRON,
    // default 04:00) that deterministically consolidates memory — promote facts
    // that keep earning recall, decay stale extraction noise. No model call, so
    // it's safe to leave on everywhere.
    const dreamingCron = process.env['MODULUS_DREAMING_CRON']?.trim();
    setupDreaming({
      memory,
      scheduler,
      log,
      enabled: cfg.memory?.dreaming?.enabled ?? true,
      ...(dreamingCron ? { cron: dreamingCron } : {}),
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

    // One instant-responder shared by both chat surfaces (Telegram + panel) so
    // their anti-repeat variant history is shared. Off entirely when the setting
    // is disabled. Config changes take effect on the next restart.
    const instantResponder =
      cfg.instantResponses?.enabled !== false
        ? createInstantResponder({ modelName: () => llm.resolveModel('chat') })
        : undefined;

    // Shared pairing bus for a live re-run of the setup wizard. pollUpdates:false
    // because the adapter below owns the only getUpdates consumer — pairing is
    // matched through the adapter's allowlist-reject middleware (tryMatch), and
    // the same manager is handed to the panel as deps.pairing for the /pair route.
    const pairing = createPairingManager({ db, log, pollUpdates: false });

    // Memory extraction: an afterTurn handler the chat dispatcher invokes
    // detached, reply-first, to pull durable user facts into the hive store.
    // Default on for Standard/Heavy, off for Small (the per-turn small-model call
    // is the dominant cost there); env MODULUS_MEMORY_EXTRACTION overrides.
    const memoryExtractor = createMemoryExtractor({
      llm,
      memory,
      log,
      enabled: cfg.memory?.extraction?.enabled ?? cfg.tier !== 'small',
    });

    // Telegram is optional. A panel-only install (no bot token / no allowlist)
    // skips the adapter entirely; the panel is the chat surface, and the nudge /
    // voice / task-notification thunks keep their safe defaults. Everything else
    // (engine, scheduler, panel, modules) runs identically either way.
    const telegram = telegramEnabled
      ? createTelegram({
          token: cfg.telegram.token,
          allowedUserIds: cfg.telegram.allowedIds,
          ownerId,
          log,
          orchestrator,
          // Route a bound chat to its agent's persona orchestrator; unbound → default.
          resolveOrchestrator: (chatId) => conversationRouter!.orchestratorFor(chatId),
          llm,
          tools,
          db,
          instantResponder,
          memoryExtractor,
          pairing,
          prefs,
          followups,
          scheduling,
          standing: { store: standingOrders, registry: agentRegistry },
          // Skill discovery surface; tiers resolve against chatTools, the same
          // registry the use_skill activation intersects against.
          skills: { skills, tools: chatTools },
          // /bind · /unbind — the user-driven writer of the channel→agent binding
          // state the handoff tool rewrites at runtime.
          binding: { router: conversationRouter, registry: agentRegistry },
          heartbeatStats: () => heartbeat.stats(),
          agentRegistry,
          agentQueue,
          agentAttachmentsDir: attachmentsDir,
          logFilePath: logFilePath(home),
          schedulerStats: () => scheduler.stats(),
          schedulerList: () => [...scheduler.list()],
          modules: () => collectModuleReadiness(modulesRoots, db),
          moduleCommands: () => loader.commands(),
          moduleIntercepts: () => loader.intercepts(),
          moduleAfterReplies: () => loader.afterReplies(),
          moduleAfterTurns: () => loader.afterTurns(),
          moduleCallbacks: () => loader.callbacks(),
          moduleVoiceMessages: () => loader.voiceMessages(),
          // Yes/No on an agent-approval prompt arrives here as a callback; resolve the
          // parked tool call. The allowlist middleware already gated the press.
          onAgentApproval: (id, approved, fromUserId) =>
            approvalManager.resolveFromTelegram(id, approved, fromUserId),
          // Self-improving-skill review: /proposals lists pending; a Yes/No press
          // approves (commit + hot-load) or rejects. Owner-only by the allowlist gate.
          proposals: { listPending: () => skillImprove.store.listPending() },
          onSkillProposal: (id, approved) => {
            if (approved) void skillImprove.manager.approve(id, 'telegram');
            else skillImprove.manager.reject(id, 'telegram');
          },
        })
      : null;
    if (telegram) {
      cleanups.push(() => telegram.stop());
      // Now that the adapter exists, push approval prompts to the owner(s) over
      // Telegram. Best-effort per chat — a send failure leaves the row pending and
      // still answerable from the panel.
      approvalManager.setNotifier(async (approval) => {
        for (const chatId of cfg.telegram.allowedIds) {
          await telegram.sendApprovalRequest(chatId, approval);
        }
      });
      // Push a new skill proposal to the owner(s) for review. Best-effort per chat.
      skillImprove.manager.setNotifier(async (proposal) => {
        for (const chatId of cfg.telegram.allowedIds) {
          await telegram.sendSkillProposal(chatId, proposal);
        }
      });
    }
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
            mod: surface.module,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    };
    // Wire the scheduler -> Telegram nudge path, then fan out to other surfaces.
    // Without Telegram, nudges still reach any other chat surface (e.g. Discord).
    dispatchNudge = async (nudge) => {
      if (telegram) await telegram.sendNudge(nudge);
      await mirrorNudgeToSurfaces(nudge);
    };
    // Voice notes and task-done pings are Telegram-only paths; left at their
    // safe defaults (warn-noop / noop) on a panel-only install.
    if (telegram) {
      sendVoiceImpl = (chatId, voice) => telegram.sendVoice(chatId, voice);
      sendMessageImpl = (chatId, text) => telegram.sendMessage(chatId, text);
      sendPhotoImpl = (chatId, photo) => telegram.sendPhoto(chatId, photo);
      sendTaskNotification = (chatId, text) => telegram.sendMessage(chatId, text);
    }
    // Point the tool registry's confirm hook at a surface router. Modules
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
      // An agent DM turn is ATTENDED — the owner is watching the panel stream
      // that drives it — so the confirm renders inline there. No live panel
      // renderer means the stream just closed: fail closed, never park a DM
      // confirm in the unattended approval queue (its taskId would be bogus).
      if (ctx.chatId !== undefined && isAgentDmChatId(ctx.chatId)) {
        const viaPanel = panelConfirmBus.tryConfirm(handler, args, ctx);
        return viaPanel ?? false;
      }
      if (ctx.chatId !== undefined && isAgentChatId(ctx.chatId)) {
        let preview: string;
        try {
          preview = handler.confirmPrompt
            ? handler.confirmPrompt(args)
            : `Run \`${handler.name}\`?`;
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
      // (A) A live browser chat turn for this chatId renders the confirm inline.
      // When no panel turn is active this returns null and we fall through to (B)
      // chat surfaces / Telegram, so the prompt always reaches the owner somewhere.
      const viaPanel = panelConfirmBus.tryConfirm(handler, args, ctx);
      if (viaPanel) return viaPanel;
      if (ctx.chatId !== undefined) {
        for (const surface of loader.chatSurfaces()) {
          let owns = false;
          try {
            owns = surface.ownsChat(ctx.chatId);
          } catch (e) {
            log.warn('chat surface ownsChat threw — skipping', {
              mod: surface.module,
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
              mod: surface.module,
              tool: handler.name,
              error: e instanceof Error ? e.message : String(e),
            });
            return false;
          }
        }
      }
      // Last resort: ask over Telegram. With no Telegram adapter and no panel /
      // chat-surface renderer that claimed the prompt, fail closed — a confirm-
      // tier tool must never run when its prompt couldn't be delivered.
      return telegram ? telegram.confirmToolCall(handler, args, ctx) : false;
    };
    let lastSetupIssueSignature = '';
    notifySetupIssues = async () => {
      const issues = setupIssuesForNudge(collectModuleReadiness(modulesRoots, db));
      const signature = JSON.stringify(
        issues.map((e) => [e.name, e.status, e.reasons, e.nextAction]).sort(),
      );
      if (issues.length === 0) {
        lastSetupIssueSignature = '';
        return;
      }
      if (signature === lastSetupIssueSignature) return;
      const chats = telegram ? knownAllowedChats(db, cfg.telegram.allowedIds) : [];
      if (chats.length === 0) return;
      lastSetupIssueSignature = signature;
      const text = formatSetupIssuesNudge(issues);
      // `chats` is only non-empty when `telegram` is set (guarded above), but the
      // optional call keeps the type-checker happy across the closure boundary.
      for (const chatId of chats) await telegram?.sendMessage(chatId, text);
      // Mirror the alert to other chat surfaces (e.g. Discord) as a nudge.
      await mirrorNudgeToSurfaces({
        chatId: ownerId,
        text,
        key: 'setup-issues',
        reason: 'Setup issues detected',
      });
    };

    if (telegram) await telegram.start();
    else log.info('telegram disabled — panel-only install (no bot token configured)');
    await notifySetupIssues();
    scheduler.start();

    const metricsWriter = createMetricsWriter({
      path: metricsFilePath(home),
      log,
      scheduler,
      moduleReloads: () => loader.reloadCounts(),
      moduleTripwireDenials: () => loader.tripwireDenials(),
      startedAt: Date.now(),
    });
    metricsWriter.start();
    cleanups.push(() => metricsWriter.stop());

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
          moduleRoots: modulesRoots,
          scheduler,
          agentRegistry,
          agentQueue,
          agentRuntime,
          llm,
          memory,
          orchestrator,
          conversationRouter,
          loader,
          // Skills section of the Modules tab; tiers resolve against chatTools,
          // the same registry the use_skill activation intersects against.
          skills: { loader: skills, tools: chatTools },
          // Self-improving-skill proposals: list + approve/reject in the panel.
          skillProposals: { store: skillImprove.store, manager: skillImprove.manager },
          standingOrders,
          heartbeat,
          confirmBus: panelConfirmBus,
          pairing,
          ...(instantResponder ? { instantResponder } : {}),
          ...(process.argv[1] ? { cliEntry: process.argv[1] } : {}),
          execArgv: process.execArgv,
          onStop: () => void shutdown('panel-stop'),
          onRestart: () => {
            restartRequested = true;
            void shutdown('panel-restart');
          },
        });
        cleanups.push(() => panel?.close());
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
      // If any of the awaited stages below hangs (module watcher, grammY
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
        await loader.shutdown();
      } catch (e) {
        log.warn('module loader shutdown failed', {
          error: e instanceof Error ? e.message : String(e),
        });
      }
      try {
        await skills.shutdown();
      } catch (e) {
        log.warn('skill loader shutdown failed', {
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
        await telegram?.stop();
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
  } catch (e) {
    log.error('daemon boot failed; unwinding partial start', {
      error: e instanceof Error ? e.message : String(e),
    });
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup();
      } catch {
        /* best-effort */
      }
    }
    throw e;
  }
}

// Serve the setup wizard in the browser, then promote to the full daemon. The
// pid lock is already held by run(). On a failed promotion we re-enter setup so
// the wizard can show the error and the user can retry — no terminal needed.
// deps is injectable for tests.
export async function runSetupAndPromote(
  home: string,
  options: StartRunOptions,
  deps: {
    startSetupServer: typeof startSetupServer;
    bootDaemon: typeof bootDaemon;
    openBrowser: typeof openBrowser;
  } = { startSetupServer, bootDaemon, openBrowser },
): Promise<void> {
  let lastError: string | null = null;
  const bindOverride = options.lan ? '0.0.0.0' : undefined;
  for (;;) {
    const server = await deps.startSetupServer(home, {
      lastError,
      ...(bindOverride ? { bindOverride } : {}),
      // The wizard's Stop button (or a SIGINT) ends the foreground process.
      onStop: () => process.exit(0),
    });
    process.stdout.write(
      `\nModulus isn't set up yet. Finish setup in your browser:\n  ${server.handle.url}\n\n`,
    );
    // Only auto-open on the first pass — on re-entry the tab is already open.
    if (!options.noOpen && lastError === null && process.stdout.isTTY) {
      deps.openBrowser(server.handle.url);
    }
    await server.completed;
    // Release the port + DB before the full daemon rebinds them.
    await server.close();
    const freshCfg = effectiveConfig(home);
    try {
      await deps.bootDaemon(home, freshCfg, options);
      return;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      process.stderr.write(`Modulus couldn't start: ${lastError}\nReturning to setup…\n`);
      // Loop: a fresh setup server boots with lastError so the wizard banners it.
    }
  }
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
