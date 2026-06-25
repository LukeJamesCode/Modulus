// Module loader. Discovery, manifest validation, capability gating, and
// hot-reload. The loader is what turns Modulus from "a bot that talks to
// Ollama" into "a bot that does anything".
//
// Lifecycle for one module:
//   1. discover    — find <root>/<name>/manifest.json
//   2. validate    — parse manifest, check name + version + modulus range
//   3. migrate     — run module-owned migrations against the shared DB
//                    using a private `_mod_<name>_migrations` table
//   4. settings    — load settings.schema.json (if present), merge defaults
//   5. prompt      — load prompt.md (if present)
//   6. import      — dynamic-import each entrypoint and call register(host)
//   7. enabled     — record state row, mark "loaded" in registries
//
// Hot-reload: a chokidar-style watch on the root. Add a folder → load it.
// Remove a folder → unload its registrations. Edit a manifest or entrypoint
// file → reload. Cache busts via a `?v=<mtime>` query string on import URL.
//
// Partial-load safety. Every host.* call records a disposer on the staging
// load record. If any entrypoint throws mid-load we run the disposers in
// LIFO order before bailing out — that way a half-loaded module can't
// leave stale Telegram commands, intercepts, prompt fragments, or scheduler
// jobs behind. Without this rollback the previous loader could leak commands
// from a broken module and the only way out was a process restart.

import { existsSync, readFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DB } from '../storage/db.js';
import { migrate as runMigrations } from '../storage/db.js';
import type { Logger } from '../util/log.js';
import type { LLM, ThinkMode } from './llm.js';
import type { AfterExecuteListener, ToolHandler, ToolRegistry } from './tools.js';
import type { Scheduler, JobHandler, ScheduledJob, NudgeAction, Nudge } from './scheduler.js';
import { matchesCron, parseCron } from './cron.js';
import type { FastCache } from './fast-cache.js';
import type { ModulePermissions } from './installer.js';
import type { VoiceService, SttProvider, TtsProvider } from './voice.js';
import {
  createModuleTripwires,
  type ModuleTripwires,
  type TripwireSurface,
} from './module-tripwires.js';
import { namespacedCache } from './fast-cache.js';
import { createChatDispatcher, type ChatDispatcher, type InboundMessage } from './chat-dispatch.js';
import { createModuleWatcher } from './module-watcher.js';

// ---------------------------------------------------------------------------
// Manifest + Host API
// ---------------------------------------------------------------------------

export interface Manifest {
  name: string;
  version: string;
  description?: string;
  // Semver range understood by the host. Phase 2 supports `>=X.Y.Z` only.
  modulus: string;
  deps?: string[];
  // Declarative — the host doesn't sandbox these in v1, but it logs anything
  // unrecognised so we surface drift.
  capabilities?: string[];
  // Manifest v2: the concrete capabilities the user consents to at install. The
  // registry publish step copies this verbatim into the index entry, and the
  // marketplace / `modulus mod install` render it on the consent screen. Honest
  // and minimal — list the domains the module contacts, binaries it spawns, and
  // filesystem roots it touches.
  permissions?: ModulePermissions;
  entrypoints?: {
    tools?: string;
    commands?: string;
    jobs?: string;
    auth?: string;
    setup?: string;
  };
  // Telegram slash commands the module contributes. Used for setMyCommands.
  telegram_commands?: Array<{ command: string; description: string }>;
  // Optional case-insensitive regex (as a string) that flags messages this
  // module's tools are relevant to. The orchestrator uses it to prune the
  // tool manifest sent to the LLM per turn — a smaller manifest cuts prompt
  // tokens and gives small models fewer tools to confuse themselves with.
  // When NO module's pattern matches, the orchestrator falls back to
  // exposing every tool (preserves the pre-filter behaviour).
  intent_pattern?: string;
  // Agent personas this module ships (manifest v2). Upserted into the fleet
  // on load with origin 'module:<name>', kept in sync on reload, removed on
  // uninstall/disable. Installing a module thus adds a delegatable specialist
  // with zero glue code — the "modules are mods" promise extended to agents.
  agents?: ManifestAgent[];
}

export interface ManifestAgent {
  name: string;
  role?: string;
  systemPrompt: string;
  // 'chat' | 'tools' | 'reason'. Defaults to 'tools' — a module specialist
  // exists to drive that module's tools.
  profile?: string;
  // Defaults to [<module name>]: scoped to the module's own tools, which is
  // exactly the short manifest a tiny model selects tools best from. Pass []
  // for a no-tools persona, or null for every registered tool.
  toolAllowlist?: string[] | null;
  // 'single' (default) | 'autonomous'.
  mode?: string;
  maxToolRounds?: number;
}

// The minimal agent-registry surface the loader needs, kept structural
// (matching createAgentRegistry's shape) instead of importing agents.ts:
// the orchestrator already imports modules.ts for the host types, so a
// loader → agent-engine import would create a module cycle.
export interface AgentFleetRegistrar {
  getByName(name: string): { id: number; origin: string | null } | undefined;
  list(): Array<{ id: number; name: string; origin: string | null }>;
  create(input: {
    name: string;
    role?: string;
    systemPrompt: string;
    toolAllowlist?: string[] | null;
    profile?: 'chat' | 'tools' | 'reason';
    mode?: 'single' | 'autonomous';
    maxToolRounds?: number;
    origin?: string | null;
  }): unknown;
  update(
    id: number,
    patch: {
      role?: string;
      systemPrompt?: string;
      toolAllowlist?: string[] | null;
      profile?: 'chat' | 'tools' | 'reason';
      mode?: 'single' | 'autonomous';
      maxToolRounds?: number;
    },
  ): unknown;
  remove(id: number): boolean;
}

export interface SettingsSchema {
  // JSON-Schema-ish but tiny: only object root with typed keys, defaults,
  // required[], description. Enough for the TUI in Phase 3 to render.
  type: 'object';
  properties: Record<
    string,
    {
      type: 'string' | 'number' | 'boolean';
      default?: string | number | boolean;
      format?: string;
      // Human-friendly field label. Falls back to a humanized key when absent.
      title?: string;
      description?: string;
      secret?: boolean;
    }
  >;
  required?: string[];
}

export interface ModuleSettings {
  get<T = unknown>(key: string, fallback?: T): T;
  set(key: string, value: string | number | boolean): void;
  all(): Record<string, string | number | boolean>;
}

// What a Telegram command handler looks like from a module's perspective.
// Modules don't depend on grammY directly — the adapter wraps grammY's
// Context into this richer, neutral shape.
export interface TelegramCommandContext {
  chatId: number;
  userId: number;
  args: string;
  reply: (text: string) => Promise<void>;
}

export type TelegramCommandHandler = (ctx: TelegramCommandContext) => Promise<void>;

export interface TelegramInterceptContext extends TelegramCommandContext {
  text: string;
  // True if calling next() should let the orchestrator handle the message.
  next: () => Promise<void>;
}

export type TelegramInterceptHandler = (ctx: TelegramInterceptContext) => Promise<void>;

// Fired after the orchestrator finishes streaming an assistant reply. Used by
// modulus-voice to synthesize and send a voice note alongside the text reply.
// Handlers run sequentially after the user-facing send completes; they must
// not throw the orchestrator off the rails so the Telegram adapter catches errors.
export interface AfterReplyContext {
  chatId: number;
  userId: number;
  text: string;
  log: Logger;
}

export type AfterReplyHandler = (ctx: AfterReplyContext) => Promise<void>;

export interface AfterTurnToolCallSummary {
  name: string;
  arguments: Record<string, unknown>;
  ok: boolean;
  resultSummary: string;
}

// Rich post-turn hook for learning/routine modules. Unlike afterReply,
// this includes the user text, conversation id, timing, and tool activity so
// modules can learn patterns outside the hot reply path.
export interface AfterTurnContext {
  chatId: number;
  userId: number;
  conversationId: number;
  userText: string;
  assistantText: string;
  startedAt: number;
  finishedAt: number;
  toolCalls: AfterTurnToolCallSummary[];
}

export type AfterTurnHandler = (ctx: AfterTurnContext) => Promise<void>;

// Post-turn reply guard. Runs after a turn's visible text is finalized but
// BEFORE it's sent, so a guard can overwrite a hallucinated reply (e.g. the
// model claiming "I deleted it" without ever calling a destructive tool).
// Synchronous and side-effect-free by contract: it sits on the reply hot path
// and must not do I/O. Return a replacement string to override the reply, or
// null to let it through. Guards run in registration order; the first non-null
// wins. Domain guards (weather/delete vocabulary) live in the module that
// owns those tools, not in core — a host without the module has neither the
// tools nor the failure mode they guard.
export interface TurnGuardInput {
  userText: string;
  assistantText: string;
  toolCalls: AfterTurnToolCallSummary[];
}
export type TurnGuard = (input: TurnGuardInput) => string | null;

// Voice-note payload a module hands the Telegram adapter. Either an
// in-memory buffer or a path to a file the adapter can stream from disk.
export interface VoicePayload {
  data?: Buffer;
  path?: string;
  caption?: string;
}

// Inbound Telegram voice note delivered to modules via
// host.telegram.onVoiceMessage. Modules don't touch grammY directly — the
// adapter wraps the file id, exposes a download helper, and surfaces basic
// metadata (duration, mime type) the handler needs to gate on.
export interface TelegramVoiceMessage {
  chatId: number;
  userId: number;
  // grammY File ID. Opaque to modules; pass into downloadToFile when needed.
  fileId: string;
  durationSec: number;
  mimeType?: string;
  log: Logger;
  // Stream the OGG/Opus bytes onto local disk at destPath. Implemented by the
  // adapter; resolves once the download finishes.
  downloadToFile: (destPath: string) => Promise<void>;
}

// Result returned by a voice-message handler. The adapter walks registered
// handlers in registration order until one returns a `{ transcript }`. The
// transcript is then injected into the orchestrator path as if the user had
// typed it. `{ skip: true }` (or `undefined`) means "I'm not opted in for
// this chat" — the adapter falls through to the next handler and, if none
// claim the message, sends a generic "turn on /voice" reply. `{ error }`
// means "I tried but failed for a specific reason" — the adapter stops
// iterating and surfaces the reason verbatim so the user sees the real
// cause (missing whisper model, transcription crash, empty audio) instead
// of a misleading "turn on /voice" prompt.
export type TelegramVoiceHandlerResult =
  | { transcript: string }
  | { skip: true }
  | { error: string }
  | void;
export type TelegramVoiceHandler = (
  msg: TelegramVoiceMessage,
) => Promise<TelegramVoiceHandlerResult>;

// Telegram callback (inline-button) context handed to module handlers.
// The adapter dispatches callbacks whose data starts with `cb:<prefix>:` to
// the handler registered for that prefix. The remaining `data` is the raw
// suffix (everything after `cb:<prefix>:`) so modules can encode small
// per-button payloads (e.g. proposal ids, slot indices).
export interface TelegramCallbackContext {
  chatId: number;
  userId: number;
  // The remainder of the callback_data after `cb:<prefix>:`. May be empty.
  data: string;
  // Send a fresh chat message to the same chat. Use this for follow-ups that
  // should appear as a normal Telegram message.
  reply: (text: string, opts?: { actions?: NudgeAction[] }) => Promise<void>;
  // Edit the message that owned the button (e.g. swap "Reschedule?" for
  // "Looking for a free slot…"). The adapter no-ops if the message can't be
  // edited (deleted, expired, etc.).
  editMessage: (text: string, opts?: { actions?: NudgeAction[] }) => Promise<void>;
  // Quick acknowledgement to dismiss Telegram's loading spinner on the button.
  ack: (text?: string) => Promise<void>;
}

export type TelegramCallbackHandler = (ctx: TelegramCallbackContext) => Promise<void>;

export interface KnownTelegramChat {
  chatId: number;
  userId: number;
  devmode: boolean;
  lastSeenAt: number;
}

export interface AuthFlow {
  // User-visible label for `modulus auth <module>`.
  label: string;
  // The runner returns a settings patch that the loader writes back into the
  // module_settings table. CLI orchestrates the I/O (prompts, callback
  // server). Phase 2 ships the declaration; Phase 3 ships the prompt UI.
  run: (io: AuthFlowIO) => Promise<Record<string, string | number | boolean>>;
}

export interface AuthFlowIO {
  prompt: (question: string, opts?: { secret?: boolean }) => Promise<string>;
  print: (line: string) => void;
}

export interface ModuleSetupContext {
  name: string;
  folder: string;
  home: string;
  db: DB;
  interactive: boolean;
  stdout: (text: string) => void;
  settings: ModuleSettings;
  // Install npm packages into the module's own folder (<folder>/node_modules)
  // when they don't already resolve from there. Host-provided so a setup
  // entrypoint never reaches into core for install machinery — a shipped
  // module's folder is its whole world. Returns true when every dep resolves
  // afterwards; failures report manual instructions on stdout (best-effort by
  // contract: the caller surfaces the result but does not undo the enable).
  ensureNpmDeps: (deps: ReadonlyArray<{ pkg: string; version: string }>) => Promise<boolean>;
}

export interface SetupEntrypointModule {
  setup?: (ctx: ModuleSetupContext) => void | Promise<void>;
  run?: (ctx: ModuleSetupContext) => void | Promise<void>;
}

// Streamed reply chunk a module receives from host.orchestrator. Mirrors
// orchestrator.ReplyChunk but is redeclared here to avoid an import cycle
// between modules.ts and orchestrator.ts.
export interface HostReplyChunk {
  delta: string;
  done: boolean;
  replace?: string;
  meta?: {
    model: string;
    promptTokens?: number;
    completionTokens?: number;
    elapsedMs: number;
    afterTurn?: AfterTurnContext;
  };
}

export interface HostUserMessage {
  chatId: number;
  userId: number;
  text: string;
  // Per-turn reasoning override. A surface's sticky per-chat setting (Telegram
  // /think · /fast) flows through here; omitted (or 'auto') keeps the default.
  thinkMode?: ThinkMode;
  // Which chat surface the turn arrived on ('telegram', 'dashboard', …). Used
  // only to label the panel's live-activity marker; never affects the prompt.
  source?: string;
  send: (chunk: HostReplyChunk) => void | Promise<void>;
}

// Confirm-tier dispatch for non-Telegram chat surfaces. An module that
// owns its own chat surface (Discord, Matrix, …) feeds user turns through
// host.orchestrator and registers a renderer here so confirm-tier tools can
// surface a Yes/No prompt in the originating chat. The renderer is
// responsible for delivering the prompt to the user and resolving the
// returned promise with the user's tap. Core enforces single-use,
// abort-on-cancel, and timeout semantics around this hook — the renderer
// only owns the UI delivery and the user-tap → boolean mapping.
//
// ownsChat() lets core route a given orchestrator chatId to the correct
// surface. It must return true for chats the module actually delivered;
// returning true for an unfamiliar chatId would steal Yes/No prompts that
// belong to another surface. Falsy or absent return means "not mine".
//
// Surfaces are checked in registration order; the first match wins. The
// Telegram adapter remains the fallback when no registered surface owns the
// chat, so existing behaviour is unchanged for Telegram-originated turns.
export interface ChatConfirmRequest {
  chatId: number;
  toolName: string;
  // Human-readable preview built from ToolHandler.confirmPrompt. Pre-rendered
  // by core so surfaces don't reach back into the tool registry.
  preview: string;
  // The originating turn's abort signal. Surfaces must observe this and
  // resolve false if it fires (e.g. /stop, transport disconnect) so a
  // long-pending confirm can't fire after the turn has been cancelled.
  signal?: AbortSignal;
}

export type ChatConfirmHandler = (req: ChatConfirmRequest) => Promise<boolean>;

export interface ChatSurfaceRegistration {
  // Predicate used to claim a chatId for this surface. Implementations
  // should be cheap — this runs on every confirm-tier dispatch.
  ownsChat: (chatId: number) => boolean;
  confirm: ChatConfirmHandler;
  // Optional proactive sink. When present, the core scheduler's nudge
  // dispatcher mirrors every proactive nudge/briefing to this surface in
  // addition to Telegram, so a surface like Discord receives the same morning
  // brief / event reminder. Receives the same Nudge the Telegram path gets;
  // the surface decides where to deliver it (e.g. DM the allowlisted user).
  deliverProactive?: (nudge: Nudge) => Promise<void>;
}

// Subset of the core Orchestrator exposed to modules. Gives non-Telegram
// surfaces a way to inject a user turn into the same conversation history
// Telegram uses, with tools and the hallucination guard intact. Each
// module's chatId can be the user's normal Telegram chat (so they share
// history) or a synthetic one (isolated history).
export interface HostOrchestrator {
  handleUserMessage(msg: HostUserMessage): Promise<void>;
}

export interface Host {
  // Identity + filesystem
  name: string;
  version: string;
  log: Logger;
  dataDir: string;

  // Shared core services
  db: DB;
  llm: LLM;
  // Optional — wired by start.ts but absent in some test harnesses. Modules
  // that need it should check at runtime and fall back to host.llm if missing.
  orchestrator?: HostOrchestrator;

  // Tripwire-enforced gateways to the outside world. A module that reaches the
  // network, spawns a binary, or touches the filesystem THROUGH these has its
  // declared permissions block enforced (a non-allowlisted host/binary/path
  // throws and is counted), so the consent screen stays truthful. Using node's
  // fetch/child_process/fs directly bypasses them — see module-tripwires.ts and
  // SECURITY.md for the (honest) threat model.
  fetch: ModuleTripwires['fetch'];
  spawn: ModuleTripwires['spawn'];
  fs: ModuleTripwires['fs'];

  // Per-module config / settings store
  settings: ModuleSettings;

  // Registries the module can hook into
  tools: {
    register: (h: ToolHandler) => void;
    unregister: (name: string) => void;
    // Hook fired after a successful tool run. The common use case is
    // invalidating fast-cache entries after a write (e.g. busting the
    // today's-events cache once add_event completes). Returns a disposer
    // that drops the listener; the loader also drops it automatically when
    // the module is unloaded so callers rarely have to invoke it.
    onAfterExecute: (toolName: string, listener: AfterExecuteListener) => void;
  };
  telegram: {
    command: (name: string, handler: TelegramCommandHandler, description?: string) => void;
    intercept: (handler: TelegramInterceptHandler) => void;
    // After-reply hook: fires once the orchestrator finishes a streamed reply.
    // Wired by core; modules opt in. Handler errors are caught by the adapter.
    afterReply: (handler: AfterReplyHandler) => void;
    // Rich post-turn hook for learning/routine modules. Fires after the
    // visible Telegram reply is sent and carries user text, conversation id,
    // timing, and summarized tool activity. Use afterReply for simple TTS.
    afterTurn: (handler: AfterTurnHandler) => void;
    // Send a voice note. Backed by the Telegram adapter when available, or a
    // no-op stub during tests so modules can register without grammY in scope.
    sendVoice: (chatId: number, voice: VoicePayload) => Promise<void>;
    // Receive inbound voice notes. The adapter walks handlers in registration
    // order; the first to return `{ transcript }` wins and the transcript is
    // injected into the orchestrator as a user turn. Returning `{ skip: true }`
    // (or nothing) passes the message to the next handler.
    onVoiceMessage: (handler: TelegramVoiceHandler) => void;
    // The default Telegram chat ID from core config. Prefer per-chat or per-routine
    // state when available; keep this as the backward-compatible fallback.
    defaultChatId: number;
    // Backward-compatible alias for older modules. New code should use
    // defaultChatId or knownChats().
    chatId: number;
    // Chats that have talked to the bot and belong to allowlisted Telegram users.
    // This is safe for proactive jobs because rows are sourced from the core
    // telegram_chats table after the adapter allowlist gate.
    knownChats: () => KnownTelegramChat[];
    // Register a handler for inline-button callbacks whose data is
    // `cb:<prefix>:<...>`. `prefix` must be [a-z0-9_-]+ so the dispatcher can
    // parse without a registry. Re-registering the same prefix replaces the
    // previous handler.
    onCallback: (prefix: string, handler: TelegramCallbackHandler) => void;
  };
  scheduler: {
    cron: (
      name: string,
      expr: string,
      handler: JobHandler,
      opts?: Pick<ScheduledJob, 'timeZone'>,
    ) => void;
    // Evaluate a cron expression against a point in time, using the SAME
    // dialect the core scheduler runs jobs with. Modules that store their own
    // cron strings (e.g. learned routines) must match through this instead of
    // re-implementing cron, so "when does this fire" can never drift between
    // a module's idea and the scheduler's. Throws on an invalid expression.
    cronMatches: (expr: string, at: Date) => boolean;
  };
  // Shared TTL cache namespaced to this module. Useful for memoizing per-
  // tick work in cron jobs (e.g. "list today's events" once even if three
  // sweeps run within a minute). Stats are reported globally in /status.
  cache: FastCache;
  prompts: {
    contribute: (fragment: string) => void;
  };
  guards: {
    // Register a post-turn reply guard (see TurnGuard). Surface-agnostic — runs
    // on the main chat orchestrator's turns. Returns a disposer; the loader also
    // drops it automatically on unload.
    register: (guard: TurnGuard) => () => void;
  };
  auth: {
    flow: (flow: AuthFlow) => void;
  };
  // Chat-surface plumbing for non-Telegram surfaces. Modules that own
  // a chat surface register a confirm renderer here so confirm-tier tools
  // route to the right place. Telegram remains wired by the adapter itself.
  chat: {
    registerConfirm: (registration: ChatSurfaceRegistration) => void;
    // Run a user turn through the full shared pipeline — module commands,
    // message intercepts, the orchestrator turn, and the afterReply/afterTurn
    // hooks — exactly as the Telegram adapter does. A chat-surface module
    // (Discord, future Matrix/Slack) calls this instead of host.orchestrator so
    // it inherits commands and intercepts for free, not just raw model turns.
    // The surface provides `reply` to render/length-cap output its own way.
    dispatchInbound: (msg: InboundMessage) => Promise<void>;
  };
  // Speech engines for the panel's two-way voice. A voice module (modulus-voice)
  // registers whisper.cpp STT / Piper TTS here; core's panel voice routes call
  // whatever is registered. Mirrors host.llm.registerProvider. Optional — wired
  // by start.ts but absent in test harnesses; register through `?.` and the
  // returned disposer is auto-dropped on unload.
  voice?: {
    registerStt: (fn: SttProvider) => () => void;
    registerTts: (fn: TtsProvider) => () => void;
  };
}

export interface EntrypointModule {
  register?: (host: Host) => void | Promise<void>;
  unregister?: (host: Host) => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Registry surfaces the loader exposes to the rest of core
// ---------------------------------------------------------------------------

export interface ModuleCommandRecord {
  module: string;
  name: string;
  description: string;
  handler: TelegramCommandHandler;
}

export interface ModuleInterceptRecord {
  module: string;
  handler: TelegramInterceptHandler;
}

export interface ModuleAfterReplyRecord {
  module: string;
  handler: AfterReplyHandler;
}

export interface ModuleAfterTurnRecord {
  module: string;
  handler: AfterTurnHandler;
}

export interface ModuleTurnGuardRecord {
  module: string;
  guard: TurnGuard;
}

export interface ModuleCallbackRecord {
  module: string;
  prefix: string;
  handler: TelegramCallbackHandler;
}

export interface ModuleVoiceMessageRecord {
  module: string;
  handler: TelegramVoiceHandler;
}

export interface ModuleAuthRecord {
  module: string;
  flow: AuthFlow;
}

export interface ModuleChatSurfaceRecord {
  module: string;
  ownsChat: (chatId: number) => boolean;
  confirm: ChatConfirmHandler;
  deliverProactive?: (nudge: Nudge) => Promise<void>;
}

export interface LoadedModule {
  name: string;
  version: string;
  enabled: boolean;
  manifest: Manifest;
  promptFragment?: string;
  // Live for diagnostics.
  registeredTools: string[];
  registeredAgents: string[];
  registeredCommands: string[];
  registeredJobs: number;
  registeredIntercepts: number;
  hasAuthFlow: boolean;
  loadedAt: number;
  error?: string;
}

export interface ModuleLoaderOptions {
  // Search paths for module folders. Each path is scanned non-recursively;
  // each subdirectory containing a manifest.json is one module. Multiple
  // roots let core ship first-party modules from <repo>/modules while
  // users also drop folders in ~/.modulus/modules.
  roots: string[];
  // Where module scratch state lives. The loader makes
  // <stateRoot>/<name>/ for each module on first load.
  stateRoot: string;

  db: DB;
  llm: LLM;
  log: Logger;
  scheduler: Scheduler;
  tools: ToolRegistry;
  // Optional. When provided, modules receive `host.orchestrator` and can
  // submit user turns through the same pipeline Telegram uses. The CLI wires
  // this in at startup; tests typically leave it undefined.
  orchestrator?: HostOrchestrator;
  // Optional. When provided, manifest `agents` entries are synced into the
  // fleet (upsert on load, removed on uninstall/disable). The CLI passes the
  // real agent registry; tests can pass a stub or omit it entirely.
  agents?: AgentFleetRegistrar;

  // Host's own version — used to validate `manifest.modulus` ranges.
  hostVersion: string;
  // The default Telegram chat ID. Passed into each module's host so older
  // nudge jobs keep their single-chat behavior when no chat-aware state exists.
  chatId: number;
  // Telegram users allowed to talk to the bot. knownChats() filters SQLite rows
  // to this set; omitted in tests means the default chat remains the only
  // allowlisted identity.
  allowedUserIds?: number[];
  // Disable hot-reload (e.g. tests).
  watch?: boolean;
  // Optional sink for voice notes. The Telegram adapter wires its grammY-backed
  // implementation here; tests leave it undefined and the loader hands a no-op
  // to modules so registration still succeeds.
  sendVoice?: (chatId: number, voice: VoicePayload) => Promise<void>;
  // Optional core voice service. When provided, modules can register STT/TTS
  // engines via host.voice and the panel's voice routes use them. Tests omit it
  // and host.voice is absent on the module's host.
  voice?: VoiceService;
  // Fired after an explicit or watched hot-reload completes. Startup calls
  // loadAll() directly and handles its own notification after Telegram is up.
  onDidReload?: () => void | Promise<void>;
}

export interface ModuleLoader {
  loadAll(): Promise<void>;
  reload(name: string): Promise<void>;
  unload(name: string): Promise<void>;
  list(): LoadedModule[];
  // The Telegram adapter calls these to drive its dispatcher. They return the
  // *current* registrations — fresh on every call so hot-reload is visible.
  commands(): ModuleCommandRecord[];
  intercepts(): ModuleInterceptRecord[];
  afterReplies(): ModuleAfterReplyRecord[];
  afterTurns(): ModuleAfterTurnRecord[];
  // Post-turn reply guards contributed by modules, in registration order.
  // The orchestrator runs them after finalizing a reply; first non-null wins.
  turnGuards(): ModuleTurnGuardRecord[];
  callbacks(): ModuleCallbackRecord[];
  voiceMessages(): ModuleVoiceMessageRecord[];
  authFlows(): ModuleAuthRecord[];
  // Chat-surface confirm renderers contributed by modules. The CLI's
  // confirm router walks these and falls back to Telegram when no surface
  // claims the chatId. Returned in registration order so first-match wins.
  chatSurfaces(): ModuleChatSurfaceRecord[];
  // Concatenated prompt fragments, in stable order (alpha by module name).
  // Pass a filter set to include only those modules' fragments — pairs
  // with `relevantModules` so the orchestrator can prune system-prompt
  // weight on the same axis it prunes the tool manifest.
  promptFragment(moduleFilter?: ReadonlySet<string>): string;
  // Names of modules whose `intent_pattern` matches the given message.
  // Returns null when nothing matched — caller should treat that as "expose
  // every tool" rather than "expose no tools". An empty array means the
  // message looks trivial or low-signal and tools should be skipped entirely.
  relevantModules(message: string): string[] | null;
  // Pause/resume hot-reload for one module while a privileged operation mutates
  // its folder. The enable/setup flow wraps a module's setup entrypoint in
  // suspend → (run setup) → resume → reload(name): the npm-install churn no
  // longer triggers a storm of mid-setup reloads, and the module loads exactly
  // once when its dependencies are in place. Idempotent; resume does not itself
  // reload — the caller decides when (and resume() does not lose a pending
  // change, since the explicit reload() supersedes it).
  suspendReload(name: string): void;
  resumeReload(name: string): void;
  // Per-module count of watcher-driven hot reloads since startup. A counter that
  // keeps climbing with no one editing files flags a reload leak; surfaced in
  // metrics + `modulus status` so it's noticeable before it pegs the CPU.
  reloadCounts(): Record<string, number>;
  // Per-module count of tripwire denials (a module reaching a host/binary/path
  // it never declared). Non-zero means a module is drifting from its consent;
  // surfaced in metrics + /status + the System tab.
  tripwireDenials(): Record<string, number>;
  shutdown(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const KNOWN_CAPABILITIES = new Set([
  'network',
  'storage',
  'telegram',
  'scheduler',
  'auth:oauth',
  'auth:token',
  'llm',
  // Declared by modules that own a chat surface other than Telegram
  // (Discord, Matrix, …). Such a module feeds user turns into
  // host.orchestrator and registers a confirm renderer via
  // host.chat.registerConfirm so confirm-tier tools can pop a per-surface
  // approval prompt instead of routing back to Telegram.
  'chat_surface',
]);

interface RegistrationsForModule {
  toolNames: string[];
  commands: ModuleCommandRecord[];
  intercepts: ModuleInterceptRecord[];
  afterReplies: ModuleAfterReplyRecord[];
  afterTurns: ModuleAfterTurnRecord[];
  turnGuards: ModuleTurnGuardRecord[];
  callbacks: ModuleCallbackRecord[];
  voiceMessages: ModuleVoiceMessageRecord[];
  chatSurfaces: ModuleChatSurfaceRecord[];
  jobsRegistered: number;
  authFlow?: AuthFlow;
  promptFragment?: string;
  // Compiled intent_pattern from the manifest. Compiled once at load time so
  // we don't pay the regex cost on every user turn.
  intentPattern?: RegExp;
  // LIFO list of cleanup callbacks captured during host.* calls. Run on a
  // failed mid-load to fully roll back a partially-registered module.
  // Also reused at unload time so the unload path can undo every host call
  // without remembering each surface (commands, intercepts, etc.) explicitly.
  disposers: Array<() => void | Promise<void>>;
}

// Trivial-chatter regex. Messages matching this almost never need a tool
// (greetings, thanks, simple acknowledgements) and the orchestrator can skip
// the tool manifest entirely on these turns. Lifted from ATLAS's keyword
// router — the words and shape have already been tuned in production.
const TRIVIAL_CHATTER_RE =
  /^(hi|hey|hello|thanks|thank you|ok|okay|sure|yes|no|yep|nah|bye|good|nice|cool|lol|haha|please|yo|sup|gm|gn|what's up|whats up)[\s!?.]*$/i;

function isTrivialChatter(message: string): boolean {
  return TRIVIAL_CHATTER_RE.test(message.trim());
}

function isLowSignalMessage(message: string): boolean {
  const compact = message.trim().replace(/[^a-z0-9]/gi, '');
  if (!compact) return true;
  if (compact.length >= 3 && new Set([...compact.toLowerCase()]).size === 1) return true;
  return false;
}

export function createModuleLoader(opts: ModuleLoaderOptions): ModuleLoader {
  const allowedUserIds = opts.allowedUserIds ?? [opts.chatId];
  const log = opts.log.child({ mod: 'modules' });
  const loaded = new Map<string, LoadedModule>();
  const registrations = new Map<string, RegistrationsForModule>();
  const dirs = new Map<string, string>(); // module name -> resolved folder
  // Per-module count of tripwire denials (a module reaching a host/binary/path
  // it never declared). A non-zero value is a module misbehaving or drifting
  // from its consent; surfaced in /status + the System tab.
  const tripwireDenials = new Map<string, number>();
  let importVersion = 0;
  let shuttingDown = false;

  // Hot-reload watcher. Owns its own timers/watchers/suspend state; calls back
  // into the loader for the semantic load/unload decisions. Disabled entirely
  // when opts.watch === false (tests).
  const watcher = createModuleWatcher({
    log,
    roots: opts.roots,
    isShuttingDown: () => shuttingDown,
    loadModule: (folder) => loadOne(folder),
    unloadModule: (name) => unloadInternal(name),
    ...(opts.onDidReload ? { onDidReload: opts.onDidReload } : {}),
    isFolderLoaded: (folder) => [...dirs.values()].some((f) => f === folder),
    nameForFolder: (folder) => [...dirs.entries()].find(([, f]) => f === folder)?.[0],
  });

  // -- module-provided agents (manifest v2) ---------------------------------
  // Agents are durable fleet rows, not transient registrations: a hot-reload
  // must NOT delete and recreate them (task history hangs off the agent id),
  // so sync is an upsert keyed by name and guarded by origin, and deletion
  // happens only on uninstall/disable/orphan-sweep.
  const AGENT_NAME_RE = /^[a-z0-9][a-z0-9_-]{1,40}$/i;

  function syncManifestAgents(manifest: Manifest, cl: Logger): string[] {
    const registrar = opts.agents;
    if (!registrar) return [];
    const origin = `module:${manifest.name}`;
    const wanted = new Set<string>();
    const registered: string[] = [];
    for (const spec of manifest.agents ?? []) {
      const name = String(spec?.name ?? '').trim();
      const systemPrompt = String(spec?.systemPrompt ?? '').trim();
      if (!AGENT_NAME_RE.test(name) || !systemPrompt) {
        cl.warn('manifest agent skipped (bad name or empty systemPrompt)', { agent: name });
        continue;
      }
      const profile =
        (['chat', 'tools', 'reason'] as const).find((p) => p === spec.profile) ?? 'tools';
      const mode = spec.mode === 'autonomous' ? ('autonomous' as const) : ('single' as const);
      const fields = {
        role: spec.role ?? `Specialist provided by ${manifest.name}`,
        systemPrompt,
        toolAllowlist: spec.toolAllowlist === undefined ? [manifest.name] : spec.toolAllowlist,
        profile,
        mode,
        ...(typeof spec.maxToolRounds === 'number' ? { maxToolRounds: spec.maxToolRounds } : {}),
      };
      const existing = registrar.getByName(name);
      if (existing && existing.origin !== origin) {
        // Never hijack a user-created agent (or another module's) by name.
        cl.warn('manifest agent collides with an existing agent — skipped', { agent: name });
        continue;
      }
      try {
        if (existing) registrar.update(existing.id, fields);
        else registrar.create({ name, ...fields, origin });
        wanted.add(name);
        registered.push(name);
      } catch (e) {
        cl.warn('manifest agent registration failed', {
          agent: name,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    // Drop agents this module registered in a previous version but no longer
    // declares (also the whole-module cleanup path when `wanted` is empty).
    for (const a of registrar.list()) {
      if (a.origin === origin && !wanted.has(a.name)) registrar.remove(a.id);
    }
    return registered;
  }

  function removeManifestAgents(moduleName: string): void {
    const registrar = opts.agents;
    if (!registrar) return;
    const origin = `module:${moduleName}`;
    for (const a of registrar.list()) {
      if (a.origin === origin) registrar.remove(a.id);
    }
  }

  function ensureStateRow(manifest: Manifest): boolean {
    const existing = opts.db
      .prepare(`SELECT enabled, version FROM module_state WHERE name = ?`)
      .get(manifest.name) as { enabled: number; version: string } | undefined;
    if (!existing) {
      opts.db
        .prepare(
          `INSERT INTO module_state (name, version, enabled, installed_at, last_loaded_at)
           VALUES (?, ?, 1, ?, ?)`,
        )
        .run(manifest.name, manifest.version, Date.now(), Date.now());
      return true;
    }
    if (existing.version !== manifest.version) {
      opts.db
        .prepare(`UPDATE module_state SET version = ?, last_loaded_at = ? WHERE name = ?`)
        .run(manifest.version, Date.now(), manifest.name);
    } else {
      opts.db
        .prepare(`UPDATE module_state SET last_loaded_at = ? WHERE name = ?`)
        .run(Date.now(), manifest.name);
    }
    return existing.enabled !== 0;
  }

  function makeSettings(name: string, schema: SettingsSchema | undefined): ModuleSettings {
    const defaults: Record<string, string | number | boolean> = {};
    if (schema) {
      for (const [k, v] of Object.entries(schema.properties)) {
        if (v.default !== undefined) defaults[k] = v.default;
      }
    }
    function readAll(): Record<string, string | number | boolean> {
      const rows = opts.db
        .prepare(`SELECT key, value FROM module_settings WHERE module = ?`)
        .all(name) as Array<{ key: string; value: string }>;
      const out: Record<string, string | number | boolean> = { ...defaults };
      for (const r of rows) {
        const decl = schema?.properties[r.key];
        if (decl?.type === 'number') out[r.key] = Number(r.value);
        else if (decl?.type === 'boolean') out[r.key] = r.value === 'true';
        else out[r.key] = r.value;
      }
      return out;
    }
    return {
      get<T = unknown>(key: string, fallback?: T): T {
        const all = readAll();
        if (key in all) return all[key] as unknown as T;
        return fallback as T;
      },
      set(key, value) {
        opts.db
          .prepare(
            `INSERT INTO module_settings (module, key, value, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(module, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          )
          .run(name, key, String(value), Date.now());
      },
      // Defensive copy so callers can't mutate the cached object.
      all: () => ({ ...readAll() }),
    };
  }

  function validateManifest(raw: unknown, source: string): Manifest {
    if (!raw || typeof raw !== 'object') throw new Error(`${source}: manifest is not an object`);
    const m = raw as Record<string, unknown>;
    if (typeof m['name'] !== 'string' || !/^[a-z][a-z0-9-]*$/i.test(m['name'])) {
      throw new Error(`${source}: invalid manifest.name`);
    }
    if (typeof m['version'] !== 'string') throw new Error(`${source}: missing manifest.version`);
    if (typeof m['modulus'] !== 'string') throw new Error(`${source}: missing manifest.modulus`);

    if (!satisfiesModulusRange(opts.hostVersion, m['modulus'] as string)) {
      throw new Error(
        `${source}: module requires modulus ${m['modulus']}, host is ${opts.hostVersion}`,
      );
    }
    const caps = Array.isArray(m['capabilities']) ? (m['capabilities'] as string[]) : [];
    for (const c of caps) {
      if (!KNOWN_CAPABILITIES.has(c)) {
        log.warn('module declares unknown capability', { name: m['name'], capability: c });
      }
    }
    return m as unknown as Manifest;
  }

  async function importEntrypoint(folder: string, rel: string): Promise<EntrypointModule> {
    const abs = resolve(folder, rel);
    // Containment: a manifest with `"entrypoint": "../../etc/passwd.js"` must
    // not let a module import code outside its own folder.
    const within = relative(folder, abs);
    if (within.startsWith('..') || isAbsolute(within)) {
      throw new Error(`entrypoint escapes module folder: ${rel}`);
    }
    if (!existsSync(abs)) throw new Error(`entrypoint missing: ${abs}`);
    const mtime = statSync(abs).mtimeMs;
    // Cache-bust via query string so hot-reload picks up code changes. The
    // counter handles filesystems/runners where rapid rewrites share an mtime.
    const url = `${pathToFileURL(abs).href}?v=${Math.floor(mtime)}-${++importVersion}`;
    return (await import(url)) as EntrypointModule;
  }

  async function runDisposers(reg: RegistrationsForModule, name: string): Promise<void> {
    // LIFO: undoing in reverse insertion order means a disposer that depends
    // on something installed earlier still has it around.
    for (let i = reg.disposers.length - 1; i >= 0; i--) {
      try {
        await reg.disposers[i]!();
      } catch (e) {
        // error (not warn) — a failing disposer can leave the module in
        // an inconsistent state; operators must see this when grepping logs.
        log.error('module disposer failed', {
          mod: name,
          error: e instanceof Error ? e.message : 'disposer error',
        });
      }
    }
    reg.disposers.length = 0;
  }

  async function loadOne(folder: string): Promise<void> {
    const manifestPath = join(folder, 'manifest.json');
    if (!existsSync(manifestPath)) return;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (e) {
      log.warn('module manifest is not valid JSON — skipping', {
        path: manifestPath,
        error: e instanceof Error ? e.message : 'parse error',
      });
      return;
    }
    const manifest = validateManifest(raw, manifestPath);

    // Tear down any prior load so re-entering loadOne is a clean reload.
    if (loaded.has(manifest.name)) await unloadInternal(manifest.name);

    const enabled = ensureStateRow(manifest);
    dirs.set(manifest.name, folder);
    if (opts.watch !== false && !shuttingDown) watcher.watchModuleFolder(manifest.name, folder);

    const cl = log.child({ mod: manifest.name });
    if (!enabled) {
      cl.info('module is disabled — skipping load');
      // A disabled module's tools are gone, so a fleet agent allowlisted to
      // them would be a dead persona — remove it; re-enable re-syncs it.
      removeManifestAgents(manifest.name);
      loaded.set(manifest.name, {
        name: manifest.name,
        version: manifest.version,
        enabled: false,
        manifest,
        registeredTools: [],
        registeredAgents: [],
        registeredCommands: [],
        registeredJobs: 0,
        registeredIntercepts: 0,
        hasAuthFlow: false,
        loadedAt: Date.now(),
      });
      return;
    }

    // Per-module migrations
    const migDir = join(folder, 'migrations');
    if (existsSync(migDir)) {
      runMigrations(opts.db, migDir, cl, { table: tableNameFor(manifest.name) });
    }

    // settings + prompt + state dir
    const schemaPath = join(folder, 'settings.schema.json');
    let schema: SettingsSchema | undefined;
    if (existsSync(schemaPath)) {
      try {
        schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as SettingsSchema;
      } catch (e) {
        cl.warn('settings.schema.json is not valid JSON — using no schema', {
          path: schemaPath,
          error: e instanceof Error ? e.message : 'parse error',
        });
      }
    }

    const promptPath = join(folder, 'prompt.md');
    const promptFragment = existsSync(promptPath)
      ? readFileSync(promptPath, 'utf8').trim() || undefined
      : undefined;

    const dataDir = join(opts.stateRoot, manifest.name);
    // 0o700: module state can hold tokens (e.g. modulus-everyday-assistant's
    // OAuth tokens). On a shared Pi/host, other local users shouldn't read it.
    // Mode is a no-op on Windows. recursive: true tolerates existing dirs.
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });

    // Tripwire-enforced gateways, scoped to this module's declared permissions.
    // A denial bumps the per-module counter surfaced in metrics/status.
    const tripwires = createModuleTripwires({
      moduleName: manifest.name,
      permissions: manifest.permissions ?? {},
      dataDir,
      log: cl,
      onDenied: (_surface: TripwireSurface) =>
        tripwireDenials.set(manifest.name, (tripwireDenials.get(manifest.name) ?? 0) + 1),
    });

    let intentPattern: RegExp | undefined;
    if (manifest.intent_pattern) {
      // Hard length cap defends against ReDoS: a malicious module can
      // otherwise ship a pattern like `(a+)+b` that pegs CPU on every user
      // message on the Pi target. 256 chars is far more than any legitimate
      // intent pattern needs.
      if (manifest.intent_pattern.length > 256) {
        cl.warn('manifest.intent_pattern exceeds 256 chars; ignoring', {
          length: manifest.intent_pattern.length,
        });
      } else {
        try {
          intentPattern = new RegExp(manifest.intent_pattern, 'i');
        } catch (e) {
          cl.warn('manifest.intent_pattern is not a valid regex; ignoring', {
            pattern: manifest.intent_pattern,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }

    const reg: RegistrationsForModule = {
      toolNames: [],
      commands: [],
      intercepts: [],
      afterReplies: [],
      afterTurns: [],
      turnGuards: [],
      callbacks: [],
      voiceMessages: [],
      chatSurfaces: [],
      jobsRegistered: 0,
      promptFragment: promptFragment ?? '',
      ...(intentPattern ? { intentPattern } : {}),
      disposers: [],
    };

    const settings = makeSettings(manifest.name, schema);

    // Every host method that mutates a registry pushes a disposer onto
    // reg.disposers. This is the safety net for partial-load failures: if
    // any entrypoint throws after, say, registering two commands and one
    // tool, we still tear all three down before bailing out.
    const host: Host = {
      name: manifest.name,
      version: manifest.version,
      log: cl,
      dataDir,
      db: opts.db,
      llm: opts.llm.registerProvider
        ? {
            ...opts.llm,
            registerProvider: (provider) => {
              const off = opts.llm.registerProvider!(provider);
              reg.disposers.push(off);
              return off;
            },
          }
        : opts.llm,
      ...(opts.orchestrator ? { orchestrator: opts.orchestrator } : {}),
      fetch: tripwires.fetch,
      spawn: tripwires.spawn,
      fs: tripwires.fs,
      settings,
      tools: {
        register: (h) => {
          opts.tools.register({ ...h, module: manifest.name });
          reg.toolNames.push(h.name);
          reg.disposers.push(() => {
            opts.tools.unregister(h.name);
            reg.toolNames = reg.toolNames.filter((n) => n !== h.name);
          });
        },
        unregister: (name) => {
          opts.tools.unregister(name);
          reg.toolNames = reg.toolNames.filter((n) => n !== name);
        },
        onAfterExecute: (toolName, listener) => {
          const off = opts.tools.onAfterExecute(toolName, listener);
          reg.disposers.push(off);
        },
      },
      telegram: {
        command: (name, handler, description = '') => {
          const record: ModuleCommandRecord = {
            module: manifest.name,
            name,
            description,
            handler,
          };
          reg.commands.push(record);
          reg.disposers.push(() => {
            const idx = reg.commands.indexOf(record);
            if (idx >= 0) reg.commands.splice(idx, 1);
          });
        },
        intercept: (handler) => {
          const record: ModuleInterceptRecord = { module: manifest.name, handler };
          reg.intercepts.push(record);
          reg.disposers.push(() => {
            const idx = reg.intercepts.indexOf(record);
            if (idx >= 0) reg.intercepts.splice(idx, 1);
          });
        },
        afterReply: (handler) => {
          const record: ModuleAfterReplyRecord = { module: manifest.name, handler };
          reg.afterReplies.push(record);
          reg.disposers.push(() => {
            const idx = reg.afterReplies.indexOf(record);
            if (idx >= 0) reg.afterReplies.splice(idx, 1);
          });
        },
        afterTurn: (handler) => {
          const record: ModuleAfterTurnRecord = { module: manifest.name, handler };
          reg.afterTurns.push(record);
          reg.disposers.push(() => {
            const idx = reg.afterTurns.indexOf(record);
            if (idx >= 0) reg.afterTurns.splice(idx, 1);
          });
        },
        sendVoice: async (chatId, voice) => {
          if (!opts.sendVoice) {
            cl.warn('sendVoice called but adapter has no voice sink');
            return;
          }
          await opts.sendVoice(chatId, voice);
        },
        onVoiceMessage: (handler) => {
          const record: ModuleVoiceMessageRecord = { module: manifest.name, handler };
          reg.voiceMessages.push(record);
          reg.disposers.push(() => {
            const idx = reg.voiceMessages.indexOf(record);
            if (idx >= 0) reg.voiceMessages.splice(idx, 1);
          });
        },
        defaultChatId: opts.chatId,
        chatId: opts.chatId,
        knownChats: () => knownTelegramChats(opts.db, allowedUserIds),
        onCallback: (prefix, handler) => {
          if (!/^[a-z0-9_-]+$/i.test(prefix)) {
            // The dispatcher splits on ':' — anything outside this charset
            // would create an ambiguous match. Fail loud (Rule 12) at
            // registration time rather than silently dropping clicks later.
            throw new Error(
              `telegram.onCallback: prefix must match /^[a-z0-9_-]+$/i (got "${prefix}")`,
            );
          }
          const record: ModuleCallbackRecord = {
            module: manifest.name,
            prefix,
            handler,
          };
          // Replace any prior record for the same prefix so hot-reload picks
          // up the new handler without leaving the stale one to dispatch.
          const existing = reg.callbacks.findIndex((c) => c.prefix === prefix);
          if (existing >= 0) reg.callbacks.splice(existing, 1);
          reg.callbacks.push(record);
          reg.disposers.push(() => {
            const idx = reg.callbacks.indexOf(record);
            if (idx >= 0) reg.callbacks.splice(idx, 1);
          });
        },
      },
      scheduler: {
        cron: (name, expr, handler, schedulerOpts) => {
          opts.scheduler.register({
            module: manifest.name,
            name,
            cron: expr,
            handler,
            ...(schedulerOpts?.timeZone ? { timeZone: schedulerOpts.timeZone } : {}),
          });
          reg.jobsRegistered += 1;
          reg.disposers.push(() => {
            // Scheduler doesn't support per-job unregister; we tear all
            // of this module's jobs down at unload time. Recording the
            // disposer so it counts as an undo step keeps the rollback
            // trace symmetric across surfaces.
            reg.jobsRegistered = Math.max(0, reg.jobsRegistered - 1);
          });
        },
        cronMatches: (expr, at) => matchesCron(parseCron(expr), at),
      },
      cache: namespacedCache(manifest.name, opts.scheduler.cache),
      prompts: {
        contribute: (fragment) => {
          const before = reg.promptFragment ?? '';
          reg.promptFragment = (before ? before + '\n\n' : '') + fragment;
          reg.disposers.push(() => {
            reg.promptFragment = before;
          });
        },
      },
      guards: {
        register: (guard) => {
          const record: ModuleTurnGuardRecord = { module: manifest.name, guard };
          reg.turnGuards.push(record);
          const off = (): void => {
            const idx = reg.turnGuards.indexOf(record);
            if (idx >= 0) reg.turnGuards.splice(idx, 1);
          };
          reg.disposers.push(off);
          return off;
        },
      },
      auth: {
        flow: (flow) => {
          const before = reg.authFlow;
          reg.authFlow = flow;
          reg.disposers.push(() => {
            reg.authFlow = before;
          });
        },
      },
      chat: {
        registerConfirm: (registration) => {
          const record: ModuleChatSurfaceRecord = {
            module: manifest.name,
            ownsChat: registration.ownsChat,
            confirm: registration.confirm,
            ...(registration.deliverProactive
              ? { deliverProactive: registration.deliverProactive }
              : {}),
          };
          reg.chatSurfaces.push(record);
          reg.disposers.push(() => {
            const idx = reg.chatSurfaces.indexOf(record);
            if (idx >= 0) reg.chatSurfaces.splice(idx, 1);
          });
        },
        dispatchInbound: async (msg) => {
          const d = getChatDispatcher();
          if (!d) {
            cl.warn('host.chat.dispatchInbound called but host.orchestrator is unavailable');
            return;
          }
          await d.dispatchInbound(msg);
        },
      },
      ...(opts.voice
        ? {
            voice: {
              registerStt: (fn) => {
                const off = opts.voice!.registerStt(fn);
                reg.disposers.push(off);
                return off;
              },
              registerTts: (fn) => {
                const off = opts.voice!.registerTts(fn);
                reg.disposers.push(off);
                return off;
              },
            },
          }
        : {}),
    };

    const entrypoints = manifest.entrypoints ?? {};
    const order: Array<[keyof typeof entrypoints, string | undefined]> = [
      ['tools', entrypoints.tools],
      ['commands', entrypoints.commands],
      ['jobs', entrypoints.jobs],
      ['auth', entrypoints.auth],
    ];

    try {
      for (const [kind, rel] of order) {
        if (!rel) continue;
        const mod = await importEntrypoint(folder, rel);
        if (typeof mod.register === 'function') {
          await mod.register(host);
        } else {
          cl.warn('entrypoint has no register() export', { kind, file: rel });
        }
        if (typeof mod.unregister === 'function') {
          const fn = mod.unregister;
          // The module's own unregister hook runs first on the next
          // unload (LIFO disposer order). Wrapped in try/catch by runDisposers.
          reg.disposers.push(() => fn(host));
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      cl.error('module load failed — rolling back', { error: msg });
      // Run every disposer collected so far. After this completes the
      // tools, commands, intercepts, jobs, prompt fragment, and any auth
      // flow registered before the error are all cleaned up.
      await runDisposers(reg, manifest.name);
      // Defensive: also drop scheduler jobs by module in case the cron
      // disposer above missed any (e.g. a module that registered jobs
      // through a different path in a future refactor).
      opts.scheduler.unregisterByModule(manifest.name);
      // A failed load means the module's tools aren't registered; don't leave
      // its agents pointing at nothing.
      removeManifestAgents(manifest.name);
      loaded.set(manifest.name, {
        name: manifest.name,
        version: manifest.version,
        enabled: true,
        manifest,
        registeredTools: [],
        registeredAgents: [],
        registeredCommands: [],
        registeredJobs: 0,
        registeredIntercepts: 0,
        hasAuthFlow: false,
        loadedAt: Date.now(),
        error: msg,
      });
      return;
    }

    registrations.set(manifest.name, reg);
    const registeredAgents = syncManifestAgents(manifest, cl);
    const entry: LoadedModule = {
      name: manifest.name,
      version: manifest.version,
      enabled: true,
      manifest,
      registeredTools: [...reg.toolNames],
      registeredAgents,
      registeredCommands: reg.commands.map((c) => c.name),
      registeredJobs: reg.jobsRegistered,
      registeredIntercepts: reg.intercepts.length,
      hasAuthFlow: reg.authFlow !== undefined,
      loadedAt: Date.now(),
    };
    if (reg.promptFragment) entry.promptFragment = reg.promptFragment;
    loaded.set(manifest.name, entry);
    cl.info('module loaded', {
      version: manifest.version,
      tools: reg.toolNames.length,
      agents: registeredAgents.length,
      commands: reg.commands.length,
      jobs: reg.jobsRegistered,
    });
  }

  async function unloadInternal(name: string): Promise<void> {
    const reg = registrations.get(name);
    if (reg) {
      // The disposer list is the symmetric undo for everything the
      // module's host calls did during load. Running it here means we
      // don't have to enumerate every registry surface separately.
      await runDisposers(reg, name);
      // Belt-and-braces: tools and scheduler are the two surfaces with
      // a "sweep by module" API, so call them too in case anything
      // slipped past the disposer trail.
      for (const t of reg.toolNames) opts.tools.unregister(t);
      opts.scheduler.unregisterByModule(name);
    }
    // Distinguish uninstall from hot-reload: a reload's unload still has the
    // folder on disk and must keep the module's fleet agents (task history
    // hangs off their ids); a removed folder is an uninstall, so the agents go.
    const folder = dirs.get(name);
    if (!folder || !existsSync(folder)) removeManifestAgents(name);
    registrations.delete(name);
    loaded.delete(name);
    watcher.detach(name);
  }

  async function loadAll(): Promise<void> {
    for (const root of opts.roots) {
      mkdirSync(root, { recursive: true });
      let entries: string[];
      try {
        entries = readdirSync(root);
      } catch {
        continue;
      }
      for (const entry of entries) {
        const folder = join(root, entry);
        try {
          if (!statSync(folder).isDirectory()) continue;
          await loadOne(folder);
        } catch (e) {
          log.warn('module discovery failed', {
            folder,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }
    // Orphan sweep: a module uninstalled while the daemon was down never got
    // its unload, so module-origin agents for modules that aren't present (or
    // didn't load) would linger as dead personas in the fleet.
    if (opts.agents) {
      const present = new Set(
        [...loaded.values()].filter((e) => e.enabled && !e.error).map((e) => `module:${e.name}`),
      );
      for (const a of opts.agents.list()) {
        if (a.origin && a.origin.startsWith('module:') && !present.has(a.origin)) {
          log.info('removing orphaned module agent', { agent: a.name, origin: a.origin });
          opts.agents.remove(a.id);
        }
      }
    }
    if (opts.watch !== false) watcher.startRootWatchers();
  }

  async function reload(name: string): Promise<void> {
    const folder = dirs.get(name);
    if (!folder) {
      // It might be a brand-new module folder.
      for (const root of opts.roots) {
        const candidate = join(root, name);
        if (existsSync(join(candidate, 'manifest.json'))) {
          await loadOne(candidate);
          await opts.onDidReload?.();
          return;
        }
      }
      throw new Error(`module '${name}' not found`);
    }
    await loadOne(folder);
    await opts.onDidReload?.();
  }

  async function unload(name: string): Promise<void> {
    await unloadInternal(name);
  }

  function list(): LoadedModule[] {
    return [...loaded.values()];
  }

  function commands(): ModuleCommandRecord[] {
    const out: ModuleCommandRecord[] = [];
    for (const r of registrations.values()) out.push(...r.commands);
    return out;
  }
  function intercepts(): ModuleInterceptRecord[] {
    const out: ModuleInterceptRecord[] = [];
    for (const r of registrations.values()) out.push(...r.intercepts);
    return out;
  }
  function afterReplies(): ModuleAfterReplyRecord[] {
    const out: ModuleAfterReplyRecord[] = [];
    for (const r of registrations.values()) out.push(...r.afterReplies);
    return out;
  }
  function afterTurns(): ModuleAfterTurnRecord[] {
    const out: ModuleAfterTurnRecord[] = [];
    for (const r of registrations.values()) out.push(...r.afterTurns);
    return out;
  }
  function turnGuards(): ModuleTurnGuardRecord[] {
    const out: ModuleTurnGuardRecord[] = [];
    for (const r of registrations.values()) out.push(...r.turnGuards);
    return out;
  }
  function callbacks(): ModuleCallbackRecord[] {
    const out: ModuleCallbackRecord[] = [];
    for (const r of registrations.values()) out.push(...r.callbacks);
    return out;
  }
  function voiceMessages(): ModuleVoiceMessageRecord[] {
    const out: ModuleVoiceMessageRecord[] = [];
    for (const r of registrations.values()) out.push(...r.voiceMessages);
    return out;
  }
  function authFlows(): ModuleAuthRecord[] {
    const out: ModuleAuthRecord[] = [];
    for (const [name, r] of registrations.entries()) {
      if (r.authFlow) out.push({ module: name, flow: r.authFlow });
    }
    return out;
  }
  function chatSurfaces(): ModuleChatSurfaceRecord[] {
    const out: ModuleChatSurfaceRecord[] = [];
    for (const r of registrations.values()) out.push(...r.chatSurfaces);
    return out;
  }

  // The shared inbound pipeline handed to chat-surface modules via
  // host.chat.dispatchInbound. Built lazily and memoized: it closes over the
  // live registry accessors above so hot-reloaded commands/intercepts are
  // picked up without rebuilding it. Null until an orchestrator is wired (tests
  // commonly leave opts.orchestrator unset).
  let sharedChatDispatcher: ChatDispatcher | null = null;
  function getChatDispatcher(): ChatDispatcher | null {
    if (!opts.orchestrator) return null;
    if (!sharedChatDispatcher) {
      sharedChatDispatcher = createChatDispatcher({
        orchestrator: opts.orchestrator,
        commands,
        intercepts,
        afterReplies,
        afterTurns,
        log,
      });
    }
    return sharedChatDispatcher;
  }

  function promptFragment(moduleFilter?: ReadonlySet<string>): string {
    const parts: string[] = [];
    for (const name of [...registrations.keys()].sort()) {
      if (moduleFilter && !moduleFilter.has(name)) continue;
      const f = registrations.get(name)?.promptFragment;
      if (f) parts.push(f);
    }
    return parts.join('\n\n');
  }

  function relevantModules(message: string): string[] | null {
    if (!message) return null;
    const hasAnyPattern = [...registrations.values()].some((reg) => reg.intentPattern);
    if (!hasAnyPattern) return null;
    if (isTrivialChatter(message)) return [];
    if (isLowSignalMessage(message)) return [];
    const matched: string[] = [];
    for (const [name, reg] of registrations.entries()) {
      if (!reg.intentPattern) continue;
      // ReDoS budget: a single .test() over 50ms means the pattern is
      // catastrophic backtracking territory. We disable it for the rest of
      // the module's lifetime and skip this turn. Length-cap at load is
      // the first line of defense; this is the second.
      const startNs = process.hrtime.bigint();
      let matched_ = false;
      try {
        matched_ = reg.intentPattern.test(message);
      } catch (e) {
        log.warn('intent_pattern threw on test; disabling', {
          mod: name,
          error: e instanceof Error ? e.message : 'regex error',
        });
        reg.intentPattern = undefined;
        continue;
      }
      const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1_000_000;
      if (elapsedMs > 50) {
        log.warn('intent_pattern exceeded 50ms budget; disabling', {
          mod: name,
          elapsedMs,
        });
        reg.intentPattern = undefined;
        continue;
      }
      if (matched_) matched.push(name);
    }
    // No modules declared a pattern → caller should fall back to all tools.
    // Patterns existed but none matched → treat as chatter and skip the tool
    // manifest. Routing every "dang im tired today" through the heavy
    // tool-use profile (with the full schema block re-shipped each time) was
    // burning tokens and forcing chit-chat onto the slow model. False
    // negatives — a tool-needing phrase that no module's regex caught —
    // are fixed by widening that module's intent_pattern, not by spraying
    // tools at every unmatched line.
    if (matched.length === 0) return [];
    return matched;
  }

  async function shutdown(): Promise<void> {
    shuttingDown = true;
    await watcher.stop();
    for (const name of [...loaded.keys()]) await unloadInternal(name);
  }

  return {
    loadAll,
    reload,
    unload,
    list,
    commands,
    intercepts,
    afterReplies,
    afterTurns,
    turnGuards,
    callbacks,
    voiceMessages,
    authFlows,
    chatSurfaces,
    promptFragment,
    relevantModules,
    suspendReload: (name: string) => watcher.suspend(name),
    resumeReload: (name: string) => watcher.resume(name),
    reloadCounts: () => watcher.reloadCounts(),
    tripwireDenials: () => Object.fromEntries(tripwireDenials),
    shutdown,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tableNameFor(moduleName: string): string {
  // _mod_<safe>_migrations. Map any character outside [a-z0-9_] to underscore.
  const safe = moduleName.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  return `_mod_${safe}_migrations`;
}

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)/;

export function satisfiesModulusRange(host: string, range: string): boolean {
  const r = range.trim();
  // Accepted forms: ">=X.Y.Z", "X.Y.Z", "*"
  if (r === '*') return true;
  const m = SEMVER_RE.exec(host);
  if (!m) return false;
  const hostV = [Number(m[1]), Number(m[2]), Number(m[3])];
  let target = r;
  let op: '>=' | '=' = '>=';
  if (r.startsWith('>=')) {
    op = '>=';
    target = r.slice(2).trim();
  } else if (/^\d/.test(r)) {
    op = '=';
  } else {
    return false;
  }
  const tm = SEMVER_RE.exec(target);
  if (!tm) return false;
  const tv = [Number(tm[1]), Number(tm[2]), Number(tm[3])];
  if (op === '=') return hostV.every((v, i) => v === tv[i]);
  for (let i = 0; i < 3; i++) {
    if (hostV[i]! > tv[i]!) return true;
    if (hostV[i]! < tv[i]!) return false;
  }
  return true; // equal
}

function knownTelegramChats(db: DB, allowedUserIds: number[]): KnownTelegramChat[] {
  if (allowedUserIds.length === 0) return [];
  const placeholders = allowedUserIds.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT chat_id, user_id, devmode, last_seen_at
       FROM telegram_chats
       WHERE user_id IN (${placeholders})
       ORDER BY last_seen_at DESC`,
    )
    .all(...allowedUserIds) as Array<{
    chat_id: number;
    user_id: number;
    devmode: number;
    last_seen_at: number;
  }>;

  return rows.map((row) => ({
    chatId: row.chat_id,
    userId: row.user_id,
    devmode: row.devmode !== 0,
    lastSeenAt: row.last_seen_at,
  }));
}
