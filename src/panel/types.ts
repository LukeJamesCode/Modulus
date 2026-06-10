// Shared panel types. Kept separate from server.ts so route modules can import
// PanelDeps/PanelRuntime without a cycle back through the server bootstrap.

import type { DB } from '../storage/db.js';
import type { Logger } from '../util/log.js';
import type { createScheduler } from '../core/scheduler.js';
import type { createAgentRegistry, createAgentRuntime } from '../core/agents.js';
import type { createAgentQueue } from '../core/agent-queue.js';
import type { createRoutedLLM } from '../core/llm-router.js';
import type { MemoryStore } from '../core/memory.js';
import type { Orchestrator } from '../core/orchestrator.js';
import type { ModuleLoader } from '../core/modules.js';
import type { InstantResponder } from '../core/instant-responses.js';
import type { ModulusConfig } from '../cli/config-store.js';
import type { PanelConfirmBus } from './confirm-bus.js';

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
  llm: ReturnType<typeof createRoutedLLM>;
  // The hive-mind memory store, for the Settings memory browser (list/search/
  // delete) — the same store every agent reads and writes.
  memory: MemoryStore;
  // The daemon's live orchestrator + module loader: browser chat runs through
  // the exact same pipeline as Telegram (intercepts → orchestrator → SSE).
  orchestrator: Orchestrator;
  loader: ModuleLoader;
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
