// Shared panel types. Kept separate from server.ts so route modules can import
// PanelDeps/PanelRuntime without a cycle back through the server bootstrap.

import type { DB } from '../storage/db.js';
import type { Logger } from '../util/log.js';
import type { createScheduler } from '../core/scheduler.js';
import type { createAgentRegistry, createAgentRuntime } from '../core/agents.js';
import type { ChatActivityRegistry } from '../core/chat-activity.js';
import type { ActivityStore } from '../core/activity.js';
import type { createAgentQueue } from '../core/agent-queue.js';
import type { createRoutedLLM } from '../core/llm-router.js';
import type { MemoryStore } from '../core/memory.js';
import type { StandingOrderStore } from '../core/standing-orders.js';
import type { Heartbeat } from '../core/heartbeat.js';
import type { Orchestrator } from '../core/orchestrator.js';
import type { ConversationRouter } from '../core/conversation-routing.js';
import type { AfterTurnContext, ModuleLoader } from '../core/modules.js';
import type { VoiceService } from '../core/voice.js';
import type { SkillLoader } from '../core/skills.js';
import type { SkillProposalStore, ProposalManager } from '../core/skill-improve.js';
import type { ToolPermissionTier, ToolRegistry } from '../core/tools.js';
import type { InstantResponder } from '../core/instant-responses.js';
import type { ModulusConfig } from '../cli/config-store.js';
import type { PanelConfirmBus } from './confirm-bus.js';
import type { PairingManager } from './telegram-pairing.js';

// The live handles the panel borrows from the daemon. Engine handles
// (orchestrator, agent runtime, …) are added as their route families are
// ported; the current set is what the system/state routes need.
export interface PanelDeps {
  db: DB;
  log: Logger;
  home: string;
  config: ModulusConfig;
  moduleRoots: readonly string[];
  // The daemon's live scheduler — the panel reads its job list for the timeline
  // (read-only; the daemon is what actually fires the jobs).
  scheduler: ReturnType<typeof createScheduler>;
  // Live agent engine. The panel does CRUD + enqueue on the registry and pokes
  // the queue so work is picked up immediately (no poll wait); the daemon stays
  // the single executor. llm is used for per-agent vision capability checks.
  agentRegistry: ReturnType<typeof createAgentRegistry>;
  agentQueue: ReturnType<typeof createAgentQueue>;
  // The runtime's live event bus: the run-view SSE subscribes per task so the
  // browser updates on real events instead of polling checkpointed DB state.
  agentRuntime: ReturnType<typeof createAgentRuntime>;
  // Live read of the main assistant's in-flight turns. The Agents tab's task
  // list surfaces these as synthetic running entries of the built-in Modulus
  // agent so a Telegram/Dashboard message shows the assistant as "running".
  // Absent in tests that don't exercise it.
  chatActivity?: ChatActivityRegistry;
  // The durable Activity record (migration 0039). The Activity tab reads it as a
  // newest-first feed plus a time-bucketed timeline. Absent in tests that don't
  // exercise it (the route then reports an empty feed instead of 500-ing).
  activity?: ActivityStore;
  llm: ReturnType<typeof createRoutedLLM>;
  // The hive-mind memory store, for the Settings memory browser (list/search/
  // delete) — the same store every agent reads and writes.
  memory: MemoryStore;
  // Core memory extraction, invoked detached after a Dashboard chat turn ships —
  // the same handler the Telegram dispatch path runs, so a panel-only install
  // also auto-saves durable user facts into the hive store. Absent disables it
  // (e.g. tests that don't exercise it, or Small-tier where extraction is off).
  memoryExtractor?: (turn: AfterTurnContext) => Promise<void>;
  // The daemon's live orchestrator + module loader: browser chat runs through
  // the exact same pipeline as Telegram (intercepts → orchestrator → SSE).
  orchestrator: Orchestrator;
  // Channel→agent bindings (v2.0.0). The Channels card (Agents tab) does
  // bind/unbind, and the Dashboard chat routes its turn through this so a bound
  // owner conversation answers as the chosen agent. Absent in tests that don't
  // exercise bindings (the Dashboard then always uses the default orchestrator).
  conversationRouter?: ConversationRouter;
  loader: ModuleLoader;
  // Two-way panel voice engines (STT/TTS) contributed by modulus-voice via
  // host.voice. The chat routes use it for /api/chat/voice-in, the one-shot voice
  // clip store, and the TTS step of the chat stream. Absent when no voice module
  // is active (the Voice Hub mic then reports "not set up" instead of 404-ing).
  voice?: VoiceService;
  // The declarative-skill loader plus the chat tool registry its tiers resolve
  // against, so the Skills section can list/enable/disable/install skills and
  // render each one's tools in the same everyday language as the install
  // consent screen. Absent in tests that don't exercise skills.
  skills?: {
    loader: SkillLoader;
    tools: ToolRegistry;
  };
  // Approval-gated self-improving skills (v2.0.0): the Skills view's Proposals
  // subsection lists pending proposals and approves/rejects them. Absent in tests
  // that don't exercise proposals.
  skillProposals?: {
    store: SkillProposalStore;
    manager: ProposalManager;
  };
  // Standing orders store + the heartbeat that evaluates them. The panel does
  // CRUD on the orders and reads heartbeat stats for the System tab.
  standingOrders?: StandingOrderStore;
  heartbeat?: Heartbeat;
  // Read-only view of the daemon's routine runner so /api/routines can flag a
  // multi-step routine that is mid-run (drives the card's "running" flash).
  // Absent in tests that don't exercise the runner.
  routineRunner?: { isRunning(routineId: number): boolean };
  // The base tool registry's user-selectable tools, for the Routines step
  // editor's per-step tool picker. Excludes agent-internal built-ins (delegation,
  // approval, planning). Absent in tests that don't exercise the picker.
  toolCatalog?: () => ToolCatalogEntry[];
  // Shared with the daemon's confirm router so a confirm-tier tool fired during
  // a browser turn prompts inline in the browser (fail-closed otherwise).
  confirmBus: PanelConfirmBus;
  // Core instant responses (templated chatter replies / pre-answer acks). Shared
  // with the Telegram surface so anti-repeat history is shared. Absent when the
  // `instantResponses.enabled` setting is off.
  instantResponder?: InstantResponder;
  // argv[1] + execArgv of the daemon, so a panel-triggered restart re-execs the
  // same entrypoint under the same loader (tsx in dev, node in prod).
  cliEntry?: string;
  execArgv?: readonly string[];
  // Lifecycle hooks the daemon provides so the panel's Stop/Restart buttons can
  // drive it without racing the pid lock (the re-exec happens after shutdown
  // releases the pid). No-ops if the host doesn't supply them.
  onStop?: () => void;
  onRestart?: () => void;
  // Present only when the panel is running in setup mode (config incomplete).
  // Its presence is what flips /api/state's `setupMode` and gates the setup-only
  // routes (pairing, /api/setup/complete). `complete()` resolves the promotion
  // promise the CLI awaits; `lastError()` is the previous failed-boot message
  // the wizard shows as a banner on re-entry.
  setup?: {
    complete(): void;
    lastError(): string | null;
  };
  // Optional shared Telegram pairing manager. In full mode (Step 7) the daemon
  // creates one bound to the live adapter and passes it here, so the /pair route
  // drives pairing through the adapter's existing getUpdates consumer. In setup
  // mode this is absent and the setup routes spin up their own getUpdates-based
  // manager instead.
  pairing?: PairingManager;
}

// One user-selectable tool in the Routines step editor. `tier` drives the UI:
// 'confirm' tools can be pre-approved (with a warning); 'owner' tools always ask.
export interface ToolCatalogEntry {
  name: string;
  module: string | null;
  tier: ToolPermissionTier;
  description: string;
}

export interface PanelHandle {
  url: string;
  token: string;
  close(): Promise<void>;
}

// Per-process panel state that outlives a single request (e.g. the proactive
// toggle). Held in memory so a flip is instant.
export interface PanelRuntime {
  proactive: boolean;
}
