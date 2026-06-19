// Telegram adapter. grammY long-poll, allowlist, core slash commands.
//
// Per-chat queueing lives in the orchestrator. This adapter forwards messages
// in, buffers the streamed reply deltas, and sends the assembled text once the
// turn finishes (splitting on Telegram's 4096-char cap). Streaming in-place
// edits were considered but dropped: a single send-on-done avoids hammering
// Telegram with editMessageText calls and sidesteps its edit rate limits.
//
// Core commands wired here:
//   /start /help /newchat /stop /model /status /lasterror /modules /devmode
//   /followups /followup_cancel /followup_clear /doctor /logs /quiet /proactive
//   /nudges /why
//
// Module commands and message intercepts are pulled from the loader on
// every Telegram update, so hot-reload reflects without restarting the bot.
// `sendMessage(chatId, text)` is exposed for the scheduler's nudge dispatcher.

import { existsSync, openSync, readSync, fstatSync, closeSync, createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { Bot, InlineKeyboard, InputFile, type Context } from 'grammy';
import { collectDoctorReply } from './telegram-maintenance.js';
import type { Logger } from '../util/log.js';
import type { Orchestrator } from '../core/orchestrator.js';
import { createChatDispatcher } from '../core/chat-dispatch.js';
import type { InstantResponder } from '../core/instant-responses.js';
import type { LLM, ThinkMode } from '../core/llm.js';
import type { ToolRegistry, ToolHandler, ToolContext } from '../core/tools.js';
import type { DB } from '../storage/db.js';
import type { ChatPrefs, PrefsStore, QuietCheck } from '../core/prefs.js';
import type { Followups, FollowupRow } from '../core/followups.js';
import type { AgentRegistry } from '../core/agents.js';
import type { AgentQueue } from '../core/agent-queue.js';
import type { AgentApproval } from '../core/agent-approvals.js';
import type { SkillProposal } from '../core/skill-improve.js';
import {
  formatAgentList,
  findEditableAgent,
  handleAgentCommand,
  handleDispatch,
  handleDispatchWithAttachments,
  handleFire,
  handleHire,
  handleNewAgent,
} from './agent-commands.js';
import {
  handleRemind,
  handleEvery,
  handleScheduleList,
  handleScheduleCommand,
} from './schedule-commands.js';
import { handleStanding, type StandingDeps } from './standing-commands.js';
import { handleSkills, handleSkill, type SkillDeps } from './skill-commands.js';
import { handleBind, handleUnbind, type BindingDeps } from './binding-commands.js';
import type { SchedulingDeps } from '../core/schedule-tools.js';
import type { HeartbeatStats } from '../core/heartbeat.js';
import { formatWindow, parseDuration, parseWindow } from '../core/prefs.js';
import { describeCron } from '../core/schedule-parse.js';
import type { Nudge, NudgeAction, SchedulerStats } from '../core/scheduler.js';
import {
  formatModuleReadinessForTelegram,
  type ModuleReadiness,
} from '../core/module-readiness.js';
import type {
  AfterTurnContext,
  HostOrchestrator,
  ModuleAfterReplyRecord,
  ModuleAfterTurnRecord,
  ModuleCallbackRecord,
  ModuleVoiceMessageRecord,
  TelegramVoiceMessage,
  ModuleCommandRecord,
  ModuleInterceptRecord,
  TelegramCallbackContext,
  VoicePayload,
} from '../core/modules.js';

export interface TelegramOptions {
  token: string;
  // Numeric Telegram user IDs allowed to talk to the bot.
  allowedUserIds: number[];
  // The "owner" of this bot — by convention the first id in allowedUserIds.
  // Future RBAC (admin-only commands, destructive tool gating) hangs off this
  // distinction even though today every allowed user shares the same surface.
  ownerId?: number;
  log: Logger;
  orchestrator: Orchestrator;
  // Per-chat orchestrator override for channel→agent bindings (v2.0.0). When a
  // chat is bound to a fleet agent, this returns that agent's persona
  // orchestrator; unbound chats get the default. Omitted in tests → default
  // orchestrator for every chat. Wired in start.ts to ConversationRouter.
  resolveOrchestrator?: (chatId: number) => HostOrchestrator;
  llm: LLM;
  tools: ToolRegistry;
  db: DB;
  // Per-chat proactive prefs (quiet hours / snooze). Optional in tests.
  prefs?: PrefsStore;
  followups: Followups;
  // Natural-language scheduling (/remind, /every, /schedules). Bundles the
  // schedule store, the host time zone, and the fallback model. Optional in
  // tests; the reminder commands report unavailable when omitted.
  scheduling?: SchedulingDeps;
  // Standing orders (/standing) — the heartbeat-evaluated watches. Optional in
  // tests; the command reports unavailable when omitted.
  standing?: StandingDeps;
  // Declarative skills (/skills, /skill <name>) — discovery of the reference
  // playbooks the assistant loads on its own. Read-only; nothing here grants a
  // tool. Optional in tests; the commands report unavailable when omitted.
  skills?: SkillDeps;
  // Channel→agent bindings (/bind, /unbind). Optional in tests; the commands
  // report unavailable when omitted.
  binding?: BindingDeps;
  // Heartbeat stats for /status (last beat, cadence). Optional.
  heartbeatStats?: () => HeartbeatStats;
  // Multi-agent engine, for /agents and /dispatch. Optional in tests.
  agentRegistry?: AgentRegistry;
  agentQueue?: AgentQueue;
  // ~/.modulus/agent-attachments — where a /dispatch's attached photos/documents
  // are ingested per task. Optional; without it, attachment dispatch is off.
  agentAttachmentsDir?: string;
  // Live scheduler stats for /status (nudge counts, fast-cache hit rate).
  schedulerStats?: () => SchedulerStats;
  // Live scheduler registry for /proactive.
  schedulerList?: () => SchedulerJobSummary[];
  // For tests: a Bot factory override.
  botFactory?: (token: string) => Bot;
  // Names of installed modules for /status and /modules.
  modules?: () => ModuleReadiness[];
  // Live registry of module commands and intercepts. Called on each
  // update — hot-reload picks up additions/removals without restart.
  moduleCommands?: () => ModuleCommandRecord[];
  moduleIntercepts?: () => ModuleInterceptRecord[];
  // After-reply hooks. Fired sequentially once a streamed reply finishes;
  // modulus-voice uses this to ship a voice note alongside the text reply.
  moduleAfterReplies?: () => ModuleAfterReplyRecord[];
  // Rich after-turn hooks. Fired after the visible Telegram reply is sent;
  // learning/routine modules use this instead of entering the hot path.
  moduleAfterTurns?: () => ModuleAfterTurnRecord[];
  // Inline-button callback handlers. Buttons emitted with callbackData
  // `cb:<prefix>:<...>` are routed to the handler registered for that prefix.
  moduleCallbacks?: () => ModuleCallbackRecord[];
  // Inbound voice-message handlers. The adapter downloads the OGG/Opus voice
  // note and walks handlers in registration order; the first one returning
  // `{ transcript }` wins and the text is injected into the orchestrator path.
  moduleVoiceMessages?: () => ModuleVoiceMessageRecord[];
  // Path to ~/.modulus/log/modulus.log for /logs.
  logFilePath?: string;
  // Resolve a Yes/No press on an agent-approval prompt. Wired to the
  // ApprovalManager; the allowlist middleware has already vetted the presser.
  onAgentApproval?: (id: number, approved: boolean, fromUserId: number) => void;
  // Self-improving-skill proposals: `/proposals` lists pending ones, and a
  // Yes/No press resolves via onSkillProposal (approve → commit + hot-load).
  // Optional in tests.
  proposals?: { listPending: () => SkillProposal[] };
  onSkillProposal?: (id: number, approved: boolean, fromUserId: number) => void;
  // Core instant responses, when `instantResponses.enabled` is on. Created in
  // start.ts and shared with the panel so both surfaces share anti-repeat
  // history; omitted (undefined) when the setting is off.
  instantResponder?: InstantResponder;
  // Core memory-extraction handler (memory.extraction gate). Created in start.ts
  // and handed to the chat dispatcher so durable user facts are pulled in after
  // the reply ships; omitted when the setting/tier disables it.
  memoryExtractor?: (turn: AfterTurnContext) => Promise<void>;
  // Setup-wizard pairing bus. When the wizard is re-run while the daemon is
  // live, a non-allowlisted user can send their pairing code to the bot; the
  // allowlist-reject middleware consults this before warning them. Structural
  // (just tryMatch) to avoid a panel→adapter import cycle. The shared manager is
  // created in start.ts and also handed to the panel as deps.pairing.
  pairing?: {
    tryMatch(text: string, from: { id: number; first_name?: string }, chatId: number): boolean;
  };
}

export interface TelegramAdapter {
  start(): Promise<void>;
  stop(): Promise<void>;
  uptimeMs(): number;
  // Used by the core scheduler's nudge dispatcher.
  sendNudge(nudge: Nudge): Promise<void>;
  // Lower-level helper retained for compatibility with direct Telegram sends.
  sendMessage(chatId: number, text: string): Promise<void>;
  // Voice notes for modules like modulus-voice. Wired into the loader as
  // host.telegram.sendVoice so modules never touch grammY directly.
  sendVoice(chatId: number, voice: VoicePayload): Promise<void>;
  // Confirm-tier tool gate. Wired into the tool registry as its `confirm` hook:
  // pops a Yes/No prompt in the originating chat and resolves to the user's
  // choice. Fails closed (returns false) when there's no chat to ask in, the
  // turn was already cancelled, the prompt can't be sent, or the user doesn't
  // answer in time.
  confirmToolCall(
    handler: ToolHandler,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<boolean>;
  // Push an agent-approval prompt (with ✅/❌ buttons) to a chat. The button
  // press comes back as an `agentapprove:<id>:<yes|no>` callback.
  sendApprovalRequest(chatId: number, approval: AgentApproval): Promise<void>;
  // Push a self-improving-skill proposal (with ✅/❌ buttons) to a chat. The
  // press comes back as a `skillpropose:<id>:<yes|no>` callback.
  sendSkillProposal(chatId: number, proposal: SkillProposal): Promise<void>;
}

// How long a confirm-tier prompt waits for a Yes/No before giving up and
// failing closed. Long enough for the user to notice and tap; short enough that
// a forgotten prompt doesn't pin the per-chat turn indefinitely.
const CONFIRM_TIMEOUT_MS = 2 * 60_000;

// Single source of truth for core slash commands. `argsHint` is rendered next
// to the name in /help; `advertised` is the short description shown in
// Telegram's slash-suggestion popup (which doesn't show args) for the curated
// everyday subset (EVERYDAY_COMMANDS). The full set is always in /help.
interface CoreCommandDef {
  name: string;
  argsHint?: string;
  help: string;
  advertised: string;
}

const CORE_COMMAND_DEFS: readonly CoreCommandDef[] = [
  { name: 'start', help: 'welcome', advertised: 'Welcome' },
  { name: 'help', help: 'this list', advertised: 'List installed commands' },
  {
    name: 'followups',
    help: 'list pending proactive followups',
    advertised: 'List pending followups',
  },
  {
    name: 'followup_cancel',
    argsHint: '<id>',
    help: 'cancel a pending followup by id',
    advertised: 'Cancel a pending followup',
  },
  {
    name: 'followup_clear',
    help: 'cancel all pending followups in this chat',
    advertised: 'Clear pending followups',
  },
  {
    name: 'remind',
    argsHint: '<when>, <what>',
    help: 'set a reminder — e.g. /remind tomorrow at 9, call the dentist',
    advertised: 'Set a one-time reminder',
  },
  {
    name: 'every',
    argsHint: '<when>, <what>',
    help: 'set a repeating reminder — e.g. /every weekday at 8am, take your pills',
    advertised: 'Set a repeating reminder',
  },
  {
    name: 'schedules',
    help: 'list your active reminders',
    advertised: 'List your reminders',
  },
  {
    name: 'schedule',
    argsHint: 'cancel <id>',
    help: 'cancel a reminder by id',
    advertised: 'Cancel a reminder',
  },
  {
    name: 'standing',
    argsHint: '[add <agent>, <what> | cancel <id>]',
    help: 'standing orders the heartbeat runs on its own',
    advertised: 'Standing orders (heartbeat watches)',
  },
  {
    name: 'skills',
    help: 'list the reference skills the assistant can draw on',
    advertised: 'List available skills',
  },
  {
    name: 'skill',
    argsHint: '<name>',
    help: 'view one skill: what it does and the tools it uses',
    advertised: 'View one skill',
  },
  { name: 'newchat', help: 'reset the conversation', advertised: 'Reset the conversation' },
  { name: 'stop', help: 'cancel an in-flight reply', advertised: 'Cancel an in-flight reply' },
  {
    name: 'think',
    argsHint: 'on|off|auto',
    help: 'set reasoning for replies in this chat',
    advertised: 'Set reasoning mode for replies',
  },
  {
    name: 'fast',
    help: 'skip reasoning for quicker replies (same as /think off)',
    advertised: 'Skip reasoning for quicker replies',
  },
  { name: 'agents', help: 'list agent personas', advertised: 'List agent personas' },
  {
    name: 'dispatch',
    argsHint: '[agent] <task>',
    help: 'dispatch a task — name an agent, or just describe the task and I pick one',
    advertised: 'Dispatch a task to an agent',
  },
  {
    name: 'hire',
    argsHint: '<template> [name]',
    help: 'hire a ready-made agent from the catalog',
    advertised: 'Hire a ready-made agent',
  },
  {
    name: 'newagent',
    argsHint: '<name>',
    help: 'create a blank custom agent to configure',
    advertised: 'Create a custom agent',
  },
  {
    name: 'agent',
    argsHint: '<name> [set <knob> <value> | prompt <text> | role <text>]',
    help: 'view or change one agent in plain language',
    advertised: 'View or change an agent',
  },
  {
    name: 'fire',
    argsHint: '<name>',
    help: 'delete a user-created agent (asks to confirm)',
    advertised: 'Delete a user-created agent',
  },
  {
    name: 'bind',
    argsHint: '[<agent>]',
    help: 'talk to a specific agent in this chat (no arg shows the current one)',
    advertised: 'Bind this chat to a fleet agent',
  },
  {
    name: 'unbind',
    help: 'return this chat to the default Modulus assistant',
    advertised: 'Restore the default assistant',
  },
  {
    name: 'proposals',
    help: 'review skills the assistant has proposed (approve/reject)',
    advertised: 'Review proposed skills',
  },
  {
    name: 'model',
    help: 'show the active model + profile',
    advertised: 'Show active model and profile',
  },
  {
    name: 'status',
    help: 'bot uptime, Ollama health, installed modules',
    advertised: 'Bot uptime, Ollama health, modules',
  },
  {
    name: 'lasterror',
    help: 'last orchestrator error in this chat',
    advertised: 'Last orchestrator error',
  },
  {
    name: 'modules',
    help: 'list installed modules',
    advertised: 'List installed modules',
  },
  {
    name: 'devmode',
    argsHint: 'on|off',
    help: 'append timing/model/tokens to replies',
    advertised: 'Append timing/model/tokens to replies',
  },
  {
    name: 'quiet',
    help: 'show quiet state · /quiet on|off · /quiet 22:00-07:00 · /quiet 1h',
    advertised: 'Mute proactive nudges (window or snooze)',
  },
  {
    name: 'proactive',
    help: 'list scheduled proactive jobs and quiet state',
    advertised: 'Show proactive scheduler state',
  },
  {
    name: 'nudges',
    help: 'show recent proactive nudges in this chat',
    advertised: 'Show recent nudges',
  },
  {
    name: 'why',
    help: 'explain the most recent proactive nudge',
    advertised: 'Explain the latest nudge',
  },
  {
    name: 'doctor',
    help: 'run Modulus diagnostics in chat',
    advertised: 'Run Modulus diagnostics',
  },
  {
    name: 'logs',
    argsHint: '[N]',
    help: 'last N lines of modulus.log (default 30)',
    advertised: 'Tail recent lines of modulus.log',
  },
];

// /help is grouped by theme so the ~35 core commands scan instead of arriving
// as one wall of text. Any command not listed here still shows under "More",
// so a newly added command is never silently dropped from help.
const HELP_GROUPS: readonly { title: string; names: readonly string[] }[] = [
  { title: 'Chatting', names: ['start', 'help', 'newchat', 'stop', 'think', 'fast', 'model'] },
  { title: 'Reminders', names: ['remind', 'every', 'schedules', 'schedule', 'standing'] },
  {
    title: 'Agents & skills',
    names: [
      'agents',
      'dispatch',
      'hire',
      'newagent',
      'agent',
      'fire',
      'bind',
      'unbind',
      'skills',
      'skill',
      'proposals',
    ],
  },
  {
    title: 'Proactive nudges',
    names: [
      'followups',
      'followup_cancel',
      'followup_clear',
      'quiet',
      'proactive',
      'nudges',
      'why',
    ],
  },
  { title: 'System', names: ['status', 'modules', 'doctor', 'logs', 'lasterror', 'devmode'] },
];

function formatCoreCommand(c: CoreCommandDef): string {
  return `/${c.argsHint ? `${c.name} ${c.argsHint}` : c.name} — ${c.help}`;
}

const CORE_COMMANDS = new Set(CORE_COMMAND_DEFS.map((c) => c.name));

// The curated subset advertised in Telegram's native "/" command menu. Kept
// short on purpose: the everyday verbs an ordinary person reaches for, not the
// ~35 power/diagnostic commands. Showing all of them in the popup reads as
// "this is for engineers"; /help still lists everything, grouped. The order
// here is the order Telegram renders them.
const EVERYDAY_COMMANDS = [
  'help',
  'newchat',
  'remind',
  'every',
  'status',
  'modules',
  'stop',
] as const;

export interface TelegramHelpOptions {
  modules?: Array<Pick<ModuleReadiness, 'name' | 'enabled'> & { status?: string }>;
  moduleCommands?: ModuleCommandRecord[];
}

export interface SchedulerJobSummary {
  module: string;
  name: string;
  cron: string;
}

export interface NudgeLogRow {
  module: string;
  job: string;
  key: string | null;
  reason: string | null;
  sentAt: number;
}

export type TelegramButton = { text: string; action: string };
export type TelegramButtonRows = TelegramButton[][];

export function buildTelegramButtonRows(
  view: 'home' | 'help' | 'status' | 'model' | 'modules' | 'quiet' | 'devmode' | 'owner',
  opts: TelegramHelpOptions = {},
): TelegramButtonRows {
  if (view === 'home') {
    return [
      [
        { text: '💬 New chat', action: 'core:newchat' },
        { text: '📋 Status', action: 'core:status' },
      ],
      [{ text: '❔ Help', action: 'core:help' }],
    ];
  }

  if (view === 'help') {
    return [[{ text: '💬 New chat', action: 'core:newchat' }]];
  }

  if (view === 'status') {
    return [[{ text: '🔄 Refresh status', action: 'core:status' }]];
  }

  if (view === 'model') {
    return [[{ text: '🔄 Refresh models', action: 'core:model' }]];
  }

  if (view === 'modules') {
    const moduleRows = (opts.moduleCommands ?? [])
      .slice(0, 3)
      .map((c) => [{ text: `Run /${c.name}`, action: `module:${c.name}` }]);
    return [[{ text: '🔄 Refresh modules', action: 'core:modules' }], ...moduleRows];
  }

  if (view === 'quiet') {
    return [
      [
        { text: '🔕 Quiet on', action: 'core:quiet:on' },
        { text: '🔔 Quiet off', action: 'core:quiet:off' },
      ],
      [
        { text: '30m', action: 'core:quiet:30m' },
        { text: '1h', action: 'core:quiet:1h' },
      ],
    ];
  }

  if (view === 'devmode') {
    return [
      [
        { text: '🧪 Devmode on', action: 'core:devmode:on' },
        { text: '✅ Devmode off', action: 'core:devmode:off' },
      ],
    ];
  }

  // owner
  return [
    [
      { text: '🩺 Doctor', action: 'core:doctor' },
      { text: '📜 Logs', action: 'core:logs' },
    ],
    [
      { text: '⚠️ Last error', action: 'core:lasterror' },
      { text: '🧪 Devmode', action: 'core:devmode' },
    ],
  ];
}

function buildTelegramKeyboard(rows: TelegramButtonRows): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  rows.forEach((row, i) => {
    if (i > 0) keyboard.row();
    for (const button of row) keyboard.text(button.text, button.action);
  });
  return keyboard;
}

function formatFollowupDue(dueAt: number): string {
  return new Date(dueAt).toISOString().replace('.000Z', 'Z');
}

export function formatPendingFollowups(rows: FollowupRow[]): string {
  if (rows.length === 0) {
    return 'No pending followups for this chat.';
  }
  return [
    'Pending followups for this chat:',
    ...rows.map((r) => `#${r.id} — ${formatFollowupDue(r.dueAt)} — ${r.topic}`),
    '',
    'Cancel one with /followup_cancel <id>.',
  ].join('\n');
}

export function handleFollowupCancel(followups: Followups, chatId: number, rawId: string): string {
  const trimmed = rawId.trim();
  const id = Number.parseInt(trimmed, 10);
  if (!trimmed || !Number.isSafeInteger(id) || id <= 0 || String(id) !== trimmed) {
    return 'Usage: /followup_cancel <id>';
  }
  return followups.cancel(chatId, id)
    ? `Cancelled followup #${id}.`
    : `No pending followup #${id} for this chat.`;
}

export function handleFollowupClear(followups: Followups, chatId: number): string {
  const n = followups.clearPending(chatId);
  return n === 0
    ? 'No pending followups for this chat.'
    : `Cancelled ${n} pending followup${n === 1 ? '' : 's'} for this chat.`;
}

export function buildTelegramHelp(opts: TelegramHelpOptions = {}): string {
  const byName = new Map(CORE_COMMAND_DEFS.map((c) => [c.name, c]));
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const g of HELP_GROUPS) {
    const defs = g.names
      .map((n) => byName.get(n))
      .filter((c): c is CoreCommandDef => c !== undefined);
    if (defs.length === 0) continue;
    if (lines.length > 0) lines.push('');
    lines.push(`${g.title}:`);
    for (const c of defs) {
      lines.push(formatCoreCommand(c));
      seen.add(c.name);
    }
  }
  const ungrouped = CORE_COMMAND_DEFS.filter((c) => !seen.has(c.name));
  if (ungrouped.length > 0) {
    lines.push('', 'More:');
    for (const c of ungrouped) lines.push(formatCoreCommand(c));
  }
  const mods = opts.modules ?? [];
  const cmds = opts.moduleCommands ?? [];
  if (mods.length > 0) {
    lines.push('', 'Modules:');
    for (const e of mods)
      lines.push(`• ${e.name} (${e.status ?? (e.enabled ? 'ready' : 'disabled')})`);
  }
  if (cmds.length > 0) {
    lines.push('', 'Module commands:');
    const byModule = new Map<string, ModuleCommandRecord[]>();
    for (const c of cmds) {
      const arr = byModule.get(c.module) ?? [];
      arr.push(c);
      byModule.set(c.module, arr);
    }
    for (const [mod, list] of byModule) {
      lines.push(`  [${mod}]`);
      for (const c of list) lines.push(`  /${c.name}${c.description ? ' — ' + c.description : ''}`);
    }
  }
  return lines.join('\n');
}

function quietStateLines(
  prefs: Pick<PrefsStore, 'get' | 'isQuiet'> | undefined,
  chatId: number,
  now: () => Date,
): string[] {
  if (!prefs) return ['quiet: unavailable (prefs store not wired)'];
  const p: ChatPrefs = prefs.get(chatId);
  const check: QuietCheck = prefs.isQuiet(chatId, now());
  const window = formatWindow(p.quietStartMinute, p.quietEndMinute);
  const lines = [`quiet: ${check.quiet ? 'on' : 'off'}`];
  if (window) lines.push(`daily window: ${window}`);
  if (check.quiet && check.reason) lines.push(`quiet reason: ${check.reason}`);
  if (check.until) {
    const until = new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(check.until));
    lines.push(`quiet until: ${until}`);
  }
  return lines;
}

export function formatProactiveText(
  jobs: readonly SchedulerJobSummary[],
  prefs: Pick<PrefsStore, 'get' | 'isQuiet'> | undefined,
  chatId: number,
  now: () => Date = () => new Date(),
): string {
  const lines = ['Proactive scheduler:'];
  if (jobs.length === 0) {
    lines.push('jobs: none');
  } else {
    lines.push(`jobs: ${jobs.length}`);
    for (const j of jobs) lines.push(`• ${j.module}:${j.name} — ${describeCron(j.cron)}`);
  }
  lines.push('', 'Quiet state:', ...quietStateLines(prefs, chatId, now));
  return lines.join('\n');
}

function readRecentNudges(db: DB, chatId: number, limit: number): NudgeLogRow[] {
  const rows = db
    .prepare(
      `SELECT module, job, key, reason, sent_at
       FROM nudge_log
       WHERE chat_id = ?
       ORDER BY sent_at DESC, id DESC
       LIMIT ?`,
    )
    .all(chatId, limit) as Array<{
    module: string;
    job: string;
    key: string | null;
    reason: string | null;
    sent_at: number;
  }>;
  return rows.map((r) => ({
    module: r.module,
    job: r.job,
    key: r.key,
    reason: r.reason,
    sentAt: r.sent_at,
  }));
}

export function formatNudgesText(rows: readonly NudgeLogRow[]): string {
  if (rows.length === 0) return 'No proactive nudges have been sent in this chat yet.';
  return [
    'Recent nudges:',
    ...rows.map((r) => {
      const key = r.key ? ` key=${r.key}` : '';
      const reason = r.reason ? ` — ${r.reason}` : '';
      return `• ${new Date(r.sentAt).toISOString()} ${r.module}:${r.job}${key}${reason}`;
    }),
  ].join('\n');
}

export function handleNudges(db: DB, chatId: number, limit = 5): string {
  return formatNudgesText(readRecentNudges(db, chatId, limit));
}

export function formatWhyText(row: NudgeLogRow | null): string {
  if (!row) return 'No proactive nudges have been sent in this chat yet.';
  return [
    'Most recent nudge:',
    `module: ${row.module}`,
    `job: ${row.job}`,
    `key: ${row.key ?? '(none)'}`,
    `sent_at: ${new Date(row.sentAt).toISOString()}`,
    `reason: ${row.reason ?? '(none)'}`,
  ].join('\n');
}

export function handleWhy(db: DB, chatId: number): string {
  return formatWhyText(readRecentNudges(db, chatId, 1)[0] ?? null);
}

export function formatModulesText(modules: readonly ModuleReadiness[]): string {
  return formatModuleReadinessForTelegram(modules);
}

export function createTelegram(opts: TelegramOptions): TelegramAdapter {
  const log = opts.log.child({ mod: 'telegram' });
  const bot = (opts.botFactory ?? ((t: string) => new Bot(t)))(opts.token);
  const startedAt = Date.now();
  const allow = new Set(opts.allowedUserIds);
  const followups = opts.followups;

  function isAllowed(ctx: Context): boolean {
    const id = ctx.from?.id;
    return id !== undefined && allow.has(id);
  }

  function setDevmode(chatId: number, on: boolean): void {
    opts.db
      .prepare(
        `INSERT INTO telegram_chats (chat_id, user_id, devmode, last_seen_at)
         VALUES (?, 0, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET devmode = excluded.devmode, last_seen_at = excluded.last_seen_at`,
      )
      .run(chatId, on ? 1 : 0, Date.now());
  }

  function getDevmode(chatId: number): boolean {
    const row = opts.db
      .prepare(`SELECT devmode FROM telegram_chats WHERE chat_id = ?`)
      .get(chatId) as { devmode: number } | undefined;
    return !!row?.devmode;
  }

  function setChatThinkMode(chatId: number, mode: ThinkMode): void {
    opts.db
      .prepare(
        `INSERT INTO telegram_chats (chat_id, user_id, think_mode, last_seen_at)
         VALUES (?, 0, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET think_mode = excluded.think_mode, last_seen_at = excluded.last_seen_at`,
      )
      .run(chatId, mode, Date.now());
  }

  function getChatThinkMode(chatId: number): ThinkMode {
    const row = opts.db
      .prepare(`SELECT think_mode FROM telegram_chats WHERE chat_id = ?`)
      .get(chatId) as { think_mode: ThinkMode } | undefined;
    return row?.think_mode ?? 'auto';
  }

  function keyboardFor(view: Parameters<typeof buildTelegramButtonRows>[0]): InlineKeyboard {
    return buildTelegramKeyboard(
      buildTelegramButtonRows(view, {
        modules: opts.modules?.() ?? [],
        moduleCommands: opts.moduleCommands?.() ?? [],
      }),
    );
  }

  function keyboardForNudgeActions(actions: NudgeAction[] | undefined): InlineKeyboard | undefined {
    if (!actions || actions.length === 0) return undefined;
    const keyboard = new InlineKeyboard();
    for (const action of actions) {
      if (action.url) {
        keyboard.url(action.label, action.url);
      } else {
        const callbackData =
          action.callbackData ??
          (action.command ? `nudge:command:${action.command}` : `nudge:${action.label}`);
        keyboard.text(action.label, callbackData);
      }
      keyboard.row();
    }
    return keyboard;
  }

  async function replyWithButtons(
    ctx: Context,
    text: string,
    view: Parameters<typeof buildTelegramButtonRows>[0],
  ): Promise<void> {
    await ctx.reply(text, { reply_markup: keyboardFor(view) });
  }

  async function answerCallback(ctx: Context, text?: string): Promise<void> {
    await ctx.answerCallbackQuery(text ? { text } : undefined).catch(() => {});
  }

  // Confirm-tier tool gating. A confirm-tier tool call (e.g. modulus-codex's
  // codex_handoff) parks here while we ask the user Yes/No in the originating
  // chat. The button press arrives as a separate `confirm:<id>:<yes|no>`
  // callback update — safe because the orchestrator turn runs detached from the
  // long-poll (dispatchOrchestratorTurn uses `void`), so awaiting the prompt
  // never blocks update processing.
  // confirmSeq is process-global, so the id alone doesn't identify the chat a
  // prompt belongs to. Bind each pending confirm to its originating chat and
  // verify it on the callback, otherwise an allowlisted user in chat B could
  // press `confirm:<id>:yes` and approve a confirm-tier (often destructive)
  // tool that chat A is waiting on.
  const pendingConfirms = new Map<string, { chatId: number; resolve: (ok: boolean) => void }>();
  let confirmSeq = 0;

  async function confirmToolCall(
    handler: ToolHandler,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<boolean> {
    const chatId = ctx.chatId;
    // No chat to ask in, or the turn was already cancelled — fail closed so a
    // confirm-tier tool never runs without explicit approval.
    if (chatId === undefined) return false;
    if (ctx.signal?.aborted) return false;

    const id = String(++confirmSeq);
    let preview: string;
    try {
      preview = handler.confirmPrompt ? handler.confirmPrompt(args) : `Run \`${handler.name}\`?`;
    } catch {
      preview = `Run \`${handler.name}\`?`;
    }

    const keyboard = new InlineKeyboard()
      .text('✅ Yes', `confirm:${id}:yes`)
      .text('❌ No', `confirm:${id}:no`);

    let messageId: number | undefined;
    try {
      const sent = await bot.api.sendMessage(chatId, preview, { reply_markup: keyboard });
      messageId = sent.message_id;
    } catch (e) {
      log.warn('confirm prompt send failed', {
        tool: handler.name,
        error: e instanceof Error ? e.message : String(e),
      });
      return false; // fail closed
    }

    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean, note: string): void => {
        if (settled) return;
        settled = true;
        pendingConfirms.delete(id);
        clearTimeout(timer);
        ctx.signal?.removeEventListener('abort', onAbort);
        if (messageId !== undefined) {
          void bot.api.editMessageText(chatId, messageId, note).catch(() => {});
        }
        resolve(ok);
      };
      const onAbort = (): void => finish(false, `${preview}\n\n⏹ Cancelled.`);
      const timer = setTimeout(
        () => finish(false, `${preview}\n\n⌛ Timed out — not run.`),
        CONFIRM_TIMEOUT_MS,
      );
      timer.unref?.();
      ctx.signal?.addEventListener('abort', onAbort, { once: true });
      pendingConfirms.set(id, {
        chatId,
        resolve: (ok) =>
          // On approval the tool may take a while (e.g. a Codex call) and we send
          // no interim text, so the edited prompt is the user's only "it's
          // working" signal — say so rather than a terse "Approved."
          finish(ok, ok ? `${preview}\n\n✅ On it — working…` : `${preview}\n\n❌ Declined.`),
      });
    });
  }

  function startText(): string {
    return (
      "Hi — I'm Modulus. Send me a message and I'll reply.\n" +
      'Use the buttons below for common actions, or /help to see every command.'
    );
  }

  function modelText(): string {
    const profiles = opts.llm.listProfiles();
    const lines: string[] = [];
    for (const [name, cfg] of Object.entries(profiles)) {
      lines.push(
        cfg ? `${name}: ${cfg.model} (ctx ${cfg.contextTokens})` : `${name}: (not configured)`,
      );
    }
    return lines.join('\n');
  }

  async function statusText(): Promise<string> {
    const health = await opts.llm.health();
    const mods = opts.modules?.() ?? [];
    const uptimeS = Math.round((Date.now() - startedAt) / 1000);
    const lines = [
      `uptime: ${uptimeS}s`,
      `llm: ${health.ok ? 'ok' : 'down'} (${health.models.length} models)`,
      `tools: ${opts.tools.list().length}`,
      `modules: ${mods.length === 0 ? 'none' : mods.map((e) => e.name).join(', ')}`,
    ];
    const s = opts.schedulerStats?.();
    if (s) {
      const dropped = Object.entries(s.nudgesDropped)
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${k}=${n}`)
        .join(',');
      lines.push(
        `scheduler: ${s.jobsRegistered} jobs, ${s.nudgesSent} nudges sent` +
          (dropped ? ` (dropped: ${dropped})` : ''),
      );
      const total = s.cache.hits + s.cache.misses;
      const rate = total === 0 ? 'n/a' : `${Math.round((s.cache.hits / total) * 100)}%`;
      lines.push(`fast-cache: ${rate} hit rate (${s.cache.hits}/${total}, ${s.cache.size} keys)`);
    }
    const hb = opts.heartbeatStats?.();
    if (hb) {
      const last = hb.lastBeatAt
        ? `${Math.round((Date.now() - hb.lastBeatAt) / 1000)}s ago`
        : 'not yet';
      lines.push(`heartbeat: ${hb.cron} · last beat ${last} (${hb.beats} total)`);
    }
    return lines.join('\n');
  }

  function modulesText(): string {
    return formatModulesText(opts.modules?.() ?? []);
  }

  // Dispatch `cb:<prefix>:<rest>` callbacks to the module handler registered
  // for `<prefix>`. The trailing `<rest>` (may itself contain `:`) is handed to
  // the module as `data` so it can pack small payloads — e.g. proposal ids,
  // slot indices — without a per-button server registry.
  async function dispatchModuleCallback(ctx: Context, payload: string): Promise<void> {
    if (!ctx.chat || !ctx.from) {
      await answerCallback(ctx);
      return;
    }
    const sep = payload.indexOf(':');
    const prefix = sep === -1 ? payload : payload.slice(0, sep);
    const data = sep === -1 ? '' : payload.slice(sep + 1);
    const record = (opts.moduleCallbacks?.() ?? []).find((c) => c.prefix === prefix);
    if (!record) {
      log.warn('no module callback handler for prefix', { prefix });
      await answerCallback(ctx);
      return;
    }
    const chatId = ctx.chat.id;
    const userId = ctx.from.id;
    const cctx: TelegramCallbackContext = {
      chatId,
      userId,
      data,
      reply: async (text, replyOpts) => {
        const replyMarkup = keyboardForNudgeActions(replyOpts?.actions);
        await ctx
          .reply(text, replyMarkup ? { reply_markup: replyMarkup } : undefined)
          .catch(() => {});
      },
      editMessage: async (text, editOpts) => {
        const replyMarkup = keyboardForNudgeActions(editOpts?.actions);
        // editMessageText fails if the message has been deleted or is too old.
        // We swallow so the handler can still send a fresh reply afterward.
        await ctx
          .editMessageText(text, replyMarkup ? { reply_markup: replyMarkup } : undefined)
          .catch(() => {});
      },
      ack: async (text) => {
        await answerCallback(ctx, text);
      },
    };
    try {
      await record.handler(cctx);
    } catch (e) {
      log.warn('module callback handler threw', {
        mod: record.module,
        prefix,
        error: e instanceof Error ? e.message : String(e),
      });
      await answerCallback(ctx);
    }
  }

  // Middleware: allowlist gate.
  bot.use(async (ctx, next) => {
    if (!isAllowed(ctx)) {
      const id = ctx.from?.id;
      // Setup-wizard pairing: a non-allowlisted user may be sending the pairing
      // code from the live re-run of the wizard. Consult the bus before warning
      // them; on a match, confirm and swallow. (The new id takes effect on the
      // next restart — the `allow` Set is fixed at boot; the panel says so.)
      const text = ctx.message?.text;
      if (opts.pairing && text && ctx.from && ctx.chat?.type === 'private') {
        const matched = opts.pairing.tryMatch(
          text,
          { id: ctx.from.id, ...(ctx.from.first_name ? { first_name: ctx.from.first_name } : {}) },
          ctx.chat.id,
        );
        if (matched) {
          await ctx
            .reply("✅ You're connected to Modulus. Restart Modulus to finish.")
            .catch(() => {});
          return;
        }
      }
      log.warn('rejected message from non-allowlisted user', { from: id });
      if (ctx.chat) {
        await ctx.reply("You're not on this bot's allowlist.").catch(() => {});
      }
      return;
    }
    await next();
  });

  // Surface-neutral inbound pipeline (commands → intercepts → orchestrator turn
  // → afterReply/afterTurn hooks), shared with every other chat surface via
  // src/core/chat-dispatch.ts. The Telegram-specific bits are injected here: the
  // reply renderer (splitForTelegram), the core-command guard, and devmode.
  const chatDispatcher = createChatDispatcher({
    orchestrator: opts.orchestrator,
    ...(opts.resolveOrchestrator ? { resolveOrchestrator: opts.resolveOrchestrator } : {}),
    commands: () => opts.moduleCommands?.() ?? [],
    intercepts: () => opts.moduleIntercepts?.() ?? [],
    afterReplies: () => opts.moduleAfterReplies?.() ?? [],
    afterTurns: () => opts.moduleAfterTurns?.() ?? [],
    log,
    isCoreCommand: (head) => CORE_COMMANDS.has(head),
    getDevmode,
    getThinkMode: getChatThinkMode,
    instantResponder: opts.instantResponder,
    ...(opts.memoryExtractor ? { memoryExtractor: opts.memoryExtractor } : {}),
  });

  bot.command('start', async (ctx) => {
    await replyWithButtons(ctx, startText(), 'home');
  });

  bot.command('help', async (ctx) => {
    await replyWithButtons(
      ctx,
      buildTelegramHelp({
        modules: opts.modules?.() ?? [],
        moduleCommands: opts.moduleCommands?.() ?? [],
      }),
      'help',
    );
  });

  bot.command('followups', async (ctx) => {
    if (!ctx.chat) return;
    await ctx.reply(formatPendingFollowups(followups.listPending(ctx.chat.id)));
  });

  bot.command('followup_cancel', async (ctx) => {
    if (!ctx.chat) return;
    const arg = (ctx.match ?? '').toString();
    await ctx.reply(handleFollowupCancel(followups, ctx.chat.id, arg));
  });

  bot.command('followup_clear', async (ctx) => {
    if (!ctx.chat) return;
    await ctx.reply(handleFollowupClear(followups, ctx.chat.id));
  });

  bot.command('remind', async (ctx) => {
    if (!ctx.chat) return;
    if (!opts.scheduling) {
      await ctx.reply('Reminders are not available.');
      return;
    }
    await ctx.reply(await handleRemind(opts.scheduling, ctx.chat.id, (ctx.match ?? '').toString()));
  });

  bot.command('every', async (ctx) => {
    if (!ctx.chat) return;
    if (!opts.scheduling) {
      await ctx.reply('Reminders are not available.');
      return;
    }
    await ctx.reply(await handleEvery(opts.scheduling, ctx.chat.id, (ctx.match ?? '').toString()));
  });

  bot.command('schedules', async (ctx) => {
    if (!ctx.chat) return;
    if (!opts.scheduling) {
      await ctx.reply('Reminders are not available.');
      return;
    }
    await ctx.reply(handleScheduleList(opts.scheduling, ctx.chat.id));
  });

  bot.command('schedule', async (ctx) => {
    if (!ctx.chat) return;
    if (!opts.scheduling) {
      await ctx.reply('Reminders are not available.');
      return;
    }
    await ctx.reply(
      handleScheduleCommand(opts.scheduling, ctx.chat.id, (ctx.match ?? '').toString()),
    );
  });

  bot.command('standing', async (ctx) => {
    if (!ctx.chat) return;
    if (!opts.standing) {
      await ctx.reply('Standing orders are not available.');
      return;
    }
    await ctx.reply(handleStanding(opts.standing, ctx.chat.id, (ctx.match ?? '').toString()));
  });

  bot.command('skills', async (ctx) => {
    if (!opts.skills) {
      await ctx.reply('Skills are not available.');
      return;
    }
    await ctx.reply(handleSkills(opts.skills));
  });

  bot.command('skill', async (ctx) => {
    if (!opts.skills) {
      await ctx.reply('Skills are not available.');
      return;
    }
    await ctx.reply(handleSkill(opts.skills, (ctx.match ?? '').toString()));
  });

  bot.command('bind', async (ctx) => {
    if (!opts.binding) {
      await ctx.reply('Agent binding is not available.');
      return;
    }
    await ctx.reply(handleBind(opts.binding, (ctx.match ?? '').toString(), ctx.chat.id));
  });

  bot.command('unbind', async (ctx) => {
    if (!opts.binding) {
      await ctx.reply('Agent binding is not available.');
      return;
    }
    await ctx.reply(handleUnbind(opts.binding, ctx.chat.id));
  });

  // Push one skill proposal as a Yes/No card. Hoisted so both the notifier
  // (sendSkillProposal) and `/proposals` use one definition.
  async function pushSkillProposal(chatId: number, proposal: SkillProposal): Promise<void> {
    const keyboard = new InlineKeyboard()
      .text('✅ Approve', `skillpropose:${proposal.id}:yes`)
      .text('❌ Reject', `skillpropose:${proposal.id}:no`);
    const action = proposal.baseVersion ? 'update' : 'new skill';
    const tools = Array.isArray(proposal.manifest['tools'])
      ? (proposal.manifest['tools'] as unknown[]).map(String)
      : [];
    const text =
      `🧩 Skill proposal (${action})\n\n` +
      `${proposal.proposedBy} proposes '${proposal.skillName}'.\n` +
      `Why: ${proposal.rationale}\n` +
      `Uses tools: ${tools.length ? tools.join(', ') : 'none'}\n\n` +
      `Approve to add it (it runs no code, and grants no tool you haven't already permitted).`;
    try {
      await bot.api.sendMessage(chatId, text, { reply_markup: keyboard });
    } catch (e) {
      log.warn('sendSkillProposal failed', {
        chatId,
        id: proposal.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  bot.command('proposals', async (ctx) => {
    if (!opts.proposals) {
      await ctx.reply('Skill proposals are not available.');
      return;
    }
    const pending = opts.proposals.listPending();
    if (pending.length === 0) {
      await ctx.reply('No skill proposals are waiting for review.');
      return;
    }
    // Re-send each as its own Yes/No card so they can be acted on inline.
    await ctx.reply(`🧩 ${pending.length} skill proposal(s) awaiting review:`);
    for (const p of pending) await pushSkillProposal(ctx.chat.id, p);
  });

  bot.command('newchat', async (ctx) => {
    if (!ctx.chat) return;
    const keyboard = new InlineKeyboard()
      .text('New chat', 'newchat:yes')
      .text('Keep old chat', 'newchat:no');
    await ctx.reply('Start a new conversation?', { reply_markup: keyboard });
  });

  bot.command('stop', async (ctx) => {
    if (!ctx.chat) return;
    const cancelled = opts.orchestrator.stop(ctx.chat.id);
    await ctx.reply(cancelled ? 'Stopped.' : 'Nothing to stop.', {
      reply_markup: keyboardFor('home'),
    });
  });

  bot.command('agents', async (ctx) => {
    if (!opts.agentRegistry) {
      await ctx.reply('Agents are not available.');
      return;
    }
    await ctx.reply(formatAgentList(opts.agentRegistry));
  });

  bot.command('dispatch', async (ctx) => {
    if (!opts.agentRegistry) {
      await ctx.reply('Agents are not available.');
      return;
    }
    const arg = (ctx.match ?? '').toString();
    await ctx.reply(
      await handleDispatch(opts.agentRegistry, opts.agentQueue, arg, ctx.chat?.id, {
        llm: opts.llm,
        log,
      }),
    );
  });

  bot.command('hire', async (ctx) => {
    if (!opts.agentRegistry) {
      await ctx.reply('Agents are not available.');
      return;
    }
    await ctx.reply(handleHire(opts.agentRegistry, (ctx.match ?? '').toString()));
  });

  bot.command('newagent', async (ctx) => {
    if (!opts.agentRegistry) {
      await ctx.reply('Agents are not available.');
      return;
    }
    await ctx.reply(handleNewAgent(opts.agentRegistry, (ctx.match ?? '').toString()));
  });

  bot.command('agent', async (ctx) => {
    if (!opts.agentRegistry) {
      await ctx.reply('Agents are not available.');
      return;
    }
    await ctx.reply(handleAgentCommand(opts.agentRegistry, (ctx.match ?? '').toString()));
  });

  // /fire asks before deleting (mirrors /newchat's inline Yes/No). The guard runs
  // up front so an unknown or module-owned name gets an immediate error, not a
  // pointless confirm.
  bot.command('fire', async (ctx) => {
    if (!opts.agentRegistry) {
      await ctx.reply('Agents are not available.');
      return;
    }
    const name = (ctx.match ?? '').toString().trim();
    if (!name) {
      await ctx.reply('Usage: /fire <name>');
      return;
    }
    const editable = findEditableAgent(opts.agentRegistry, name);
    if ('error' in editable) {
      await ctx.reply(editable.error);
      return;
    }
    const keyboard = new InlineKeyboard()
      .text('🔥 Fire', `fire:yes:${editable.agent.name}`)
      .text('Cancel', 'fire:no');
    await ctx.reply(
      `Fire '${editable.agent.name}'? This deletes the agent (its task history stays).`,
      {
        reply_markup: keyboard,
      },
    );
  });

  bot.command('model', async (ctx) => {
    await replyWithButtons(ctx, modelText(), 'model');
  });

  bot.command('status', async (ctx) => {
    await replyWithButtons(ctx, await statusText(), 'status');
  });

  bot.command('lasterror', async (ctx) => {
    if (!ctx.chat) return;
    const e = opts.orchestrator.lastError(ctx.chat.id);
    await ctx.reply(e ? `Last error: ${e}` : 'No recent errors.');
  });

  // /quiet handler is testable in isolation; the bot.command wrapper just
  // does I/O. Returns the reply text.

  bot.command('modules', async (ctx) => {
    const mods = opts.modules?.() ?? [];
    if (mods.length === 0) {
      await replyWithButtons(ctx, 'No modules installed yet.', 'modules');
      return;
    }
    await replyWithButtons(ctx, modulesText(), 'modules');
  });

  bot.command('devmode', async (ctx) => {
    if (!ctx.chat) return;
    const arg = (ctx.match ?? '').toString().trim().toLowerCase();
    if (arg !== 'on' && arg !== 'off') {
      await replyWithButtons(ctx, 'Usage: /devmode on|off', 'devmode');
      return;
    }
    setDevmode(ctx.chat.id, arg === 'on');
    await replyWithButtons(ctx, `devmode ${arg}`, 'devmode');
  });

  bot.command('think', async (ctx) => {
    if (!ctx.chat) return;
    const { mode, reply } = handleThink((ctx.match ?? '').toString());
    if (mode) setChatThinkMode(ctx.chat.id, mode);
    await ctx.reply(reply);
  });

  // /fast is the everyday shortcut for "skip reasoning, answer quickly".
  bot.command('fast', async (ctx) => {
    if (!ctx.chat) return;
    setChatThinkMode(ctx.chat.id, 'off');
    await ctx.reply(handleThink('off').reply);
  });

  bot.command('quiet', async (ctx) => {
    if (!ctx.chat) return;
    if (!opts.prefs) {
      await ctx.reply('Quiet hours not available (prefs store not wired).');
      return;
    }
    const arg = (ctx.match ?? '').toString().trim().toLowerCase();
    await replyWithButtons(ctx, handleQuiet(opts.prefs, ctx.chat.id, arg), 'quiet');
  });

  bot.command('proactive', async (ctx) => {
    if (!ctx.chat) return;
    await ctx.reply(formatProactiveText(opts.schedulerList?.() ?? [], opts.prefs, ctx.chat.id));
  });

  bot.command('nudges', async (ctx) => {
    if (!ctx.chat) return;
    await ctx.reply(handleNudges(opts.db, ctx.chat.id));
  });

  bot.command('why', async (ctx) => {
    if (!ctx.chat) return;
    await ctx.reply(handleWhy(opts.db, ctx.chat.id));
  });

  bot.command('doctor', async (ctx) => {
    await ctx.reply('Running doctor checks…');
    await ctx.reply(await collectDoctorReply());
  });

  bot.command('logs', async (ctx) => {
    const file = opts.logFilePath;
    if (!file) {
      await ctx.reply('Log file path not configured.');
      return;
    }
    const arg = (ctx.match ?? '').toString().trim();
    const n = arg ? Math.max(1, Math.min(200, Number.parseInt(arg, 10) || 30)) : 30;
    await ctx.reply(handleLogs({ file, lines: n }));
  });

  bot.callbackQuery(/^newchat:(yes|no)$/, async (ctx) => {
    if (!ctx.chat) {
      await ctx.answerCallbackQuery();
      return;
    }
    const choice = ctx.match[1];
    if (choice === 'yes') {
      opts.orchestrator.newChat(ctx.chat.id);
      await ctx.editMessageText('Conversation reset.');
    } else {
      await ctx.editMessageText('Kept current conversation.');
    }
    await ctx.answerCallbackQuery();
  });

  // /fire Yes/No. The agent name rides in the callback data (names are short,
  // [a-z0-9_-], well under Telegram's 64-byte cap). handleFire re-checks the
  // guard, so a stale press can't delete a module-owned or vanished agent.
  bot.callbackQuery(/^fire:(yes|no)(?::(.+))?$/, async (ctx) => {
    const choice = ctx.match[1];
    const name = ctx.match[2];
    if (choice === 'yes' && name && opts.agentRegistry) {
      await ctx.editMessageText(handleFire(opts.agentRegistry, name)).catch(() => {});
    } else {
      await ctx.editMessageText('Kept the agent.').catch(() => {});
    }
    await ctx.answerCallbackQuery();
  });

  // Agent-approval Yes/No. The decision is global (an approval id is unique and
  // not chat-scoped) and the allowlist middleware already vetted the presser, so
  // any allowlisted user can answer. Resolving is idempotent — a stale press
  // (already decided) just no-ops in the manager.
  bot.callbackQuery(/^agentapprove:(\d+):(yes|no)$/, async (ctx) => {
    if (!ctx.from) {
      await ctx.answerCallbackQuery();
      return;
    }
    const id = Number(ctx.match[1]);
    const approved = ctx.match[2] === 'yes';
    opts.onAgentApproval?.(id, approved, ctx.from.id);
    await ctx.answerCallbackQuery({ text: approved ? 'Approved' : 'Rejected' });
    await ctx
      .editMessageText(`${approved ? '✅ Approved' : '❌ Rejected'} · agent approval #${id}`)
      .catch(() => {});
  });

  // Skill-proposal Yes/No (propose_skill). Same shape as agent approvals: global
  // id, any allowlisted user may answer, idempotent (a stale press no-ops in the
  // manager). Approve → the daemon commits the skill and hot-loads it.
  bot.callbackQuery(/^skillpropose:(\d+):(yes|no)$/, async (ctx) => {
    if (!ctx.from) {
      await ctx.answerCallbackQuery();
      return;
    }
    const id = Number(ctx.match[1]);
    const approved = ctx.match[2] === 'yes';
    opts.onSkillProposal?.(id, approved, ctx.from.id);
    await ctx.answerCallbackQuery({ text: approved ? 'Approving…' : 'Rejected' });
    await ctx
      .editMessageText(`${approved ? '✅ Approved' : '❌ Rejected'} · skill proposal #${id}`)
      .catch(() => {});
  });

  bot.on('callback_query:data', async (ctx) => {
    if (!ctx.chat || !ctx.from) {
      await answerCallback(ctx);
      return;
    }

    const data = ctx.callbackQuery.data;
    if (data.startsWith('module:')) {
      const command = data.slice('module:'.length);
      await answerCallback(ctx, `Running /${command}`);
      const handled = await chatDispatcher.invokeCommand(
        command,
        '',
        ctx.chat.id,
        ctx.from.id,
        (t) => ctx.reply(t, { reply_markup: keyboardFor('modules') }),
      );
      if (!handled)
        await replyWithButtons(ctx, `Module command /${command} is not loaded.`, 'modules');
      return;
    }

    if (data.startsWith('cb:')) {
      await dispatchModuleCallback(ctx, data.slice('cb:'.length));
      return;
    }

    if (data.startsWith('confirm:')) {
      const rest = data.slice('confirm:'.length);
      const sep = rest.indexOf(':');
      const id = sep === -1 ? rest : rest.slice(0, sep);
      const choice = sep === -1 ? '' : rest.slice(sep + 1);
      const ok = choice === 'yes';
      const pending = pendingConfirms.get(id);
      // Missing id = stale prompt (already resolved by timeout/cancel, or from a
      // previous process). Reject a press from a different chat than the one the
      // prompt was issued in — the global id must not be approvable cross-chat.
      if (!pending) {
        await answerCallback(ctx);
        return;
      }
      if (pending.chatId !== ctx.chat.id) {
        await answerCallback(ctx, 'This confirmation belongs to another chat.');
        return;
      }
      await answerCallback(ctx, ok ? 'Approved' : 'Declined');
      pending.resolve(ok);
      return;
    }

    if (data.startsWith('nudge:')) {
      await answerCallback(ctx, 'Action received.');
      return;
    }

    if (!data.startsWith('core:')) {
      await answerCallback(ctx);
      return;
    }

    const payload = data.slice('core:'.length);
    const separator = payload.indexOf(':');
    const action = separator === -1 ? payload : payload.slice(0, separator);
    const arg = separator === -1 ? undefined : payload.slice(separator + 1);
    await answerCallback(ctx);
    switch (action) {
      case 'start':
      case 'home':
        await replyWithButtons(ctx, startText(), 'home');
        break;
      case 'help':
        await replyWithButtons(
          ctx,
          buildTelegramHelp({
            modules: opts.modules?.() ?? [],
            moduleCommands: opts.moduleCommands?.() ?? [],
          }),
          'help',
        );
        break;
      case 'newchat':
        opts.orchestrator.newChat(ctx.chat.id);
        await replyWithButtons(ctx, 'Conversation reset.', 'home');
        break;
      case 'stop': {
        const cancelled = opts.orchestrator.stop(ctx.chat.id);
        await replyWithButtons(ctx, cancelled ? 'Stopped.' : 'Nothing to stop.', 'home');
        break;
      }
      case 'model':
        await replyWithButtons(ctx, modelText(), 'model');
        break;
      case 'status':
        await replyWithButtons(ctx, await statusText(), 'status');
        break;
      case 'modules':
        await replyWithButtons(ctx, modulesText(), 'modules');
        break;
      case 'lasterror': {
        const e = opts.orchestrator.lastError(ctx.chat.id);
        await ctx.reply(e ? `Last error: ${e}` : 'No recent errors.', {
          reply_markup: keyboardFor('owner'),
        });
        break;
      }
      case 'quiet':
        if (!opts.prefs) {
          await ctx.reply('Quiet hours not available (prefs store not wired).');
          break;
        }
        await replyWithButtons(ctx, handleQuiet(opts.prefs, ctx.chat.id, arg ?? ''), 'quiet');
        break;
      case 'devmode':
        if (arg !== 'on' && arg !== 'off') {
          await replyWithButtons(ctx, 'Usage: /devmode on|off', 'devmode');
          break;
        }
        setDevmode(ctx.chat.id, arg === 'on');
        await replyWithButtons(ctx, `devmode ${arg}`, 'devmode');
        break;
      case 'owner':
        await replyWithButtons(ctx, 'Owner tools:', 'owner');
        break;
      case 'doctor':
        await ctx.reply('Running doctor checks…');
        await ctx.reply(await collectDoctorReply(), { reply_markup: keyboardFor('owner') });
        break;
      case 'logs':
        await ctx.reply(
          opts.logFilePath
            ? handleLogs({ file: opts.logFilePath, lines: 30 })
            : 'Log file path not configured.',
          { reply_markup: keyboardFor('owner') },
        );
        break;
      default:
        await replyWithButtons(ctx, 'Button action is no longer available. Use /help.', 'help');
    }
  });

  const dispatchTextMessage = async (ctx: Context, text: string): Promise<void> => {
    if (!ctx.chat || !ctx.from) return;
    await chatDispatcher.dispatchInbound({
      chatId: ctx.chat.id,
      userId: ctx.from.id,
      text,
      reply: async (t) => {
        // Telegram hard-caps a message at 4096 chars. A long reply (e.g. a Codex
        // handoff answer) would otherwise be rejected by the API and silently
        // dropped — the user would see nothing.
        for (const part of splitForTelegram(t)) {
          if (part.trim().length === 0) continue; // Telegram rejects empty text
          await ctx.reply(part);
        }
      },
    });
  };

  // Free-form text + module command dispatch + intercept chain.
  bot.on('message:text', async (ctx) => {
    await dispatchTextMessage(ctx, ctx.message.text);
  });

  // Inbound voice notes. Walk registered handlers in registration order; the
  // first one returning a transcript wins, and the transcript is injected
  // back into the orchestrator path the same way a typed message would be.
  // Handlers are responsible for their own gating (per-chat pref, duration
  // caps, language). Errors are caught locally so a single module misbehave
  // can't take the long-poll loop down.
  bot.on('message:voice', async (ctx) => {
    if (!ctx.chat || !ctx.from || !ctx.message.voice) return;
    const handlers = opts.moduleVoiceMessages?.() ?? [];
    if (handlers.length === 0) {
      await ctx.reply(
        "I can't transcribe voice notes yet — install modulus-voice and /voice transcribe on.",
      );
      return;
    }

    const voice = ctx.message.voice;
    // The module passes destPath (its own temp file); we just stream the
    // file id's bytes into it. Cleanup is the module's responsibility —
    // the adapter never owns the destination.
    const downloadToFile = async (destPath: string): Promise<void> => {
      const file = await ctx.api.getFile(voice.file_id);
      if (!file.file_path) {
        throw new Error('telegram voice file has no file_path');
      }
      // Telegram's file-download URL pattern (see Bot API docs). The link is
      // valid for ~1 hour after getFile.
      const link = `https://api.telegram.org/file/bot${opts.token}/${file.file_path}`;
      const res = await fetch(link, { redirect: 'follow' });
      if (!res.ok || !res.body) {
        throw new Error(`telegram voice download failed: HTTP ${res.status}`);
      }
      await streamPipeline(
        Readable.fromWeb(
          res.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>,
        ),
        createWriteStream(destPath),
      );
    };

    const msg: TelegramVoiceMessage = {
      chatId: ctx.chat.id,
      userId: ctx.from.id,
      fileId: voice.file_id,
      durationSec: voice.duration,
      ...(voice.mime_type ? { mimeType: voice.mime_type } : {}),
      log,
      downloadToFile,
    };

    let transcript: string | null = null;
    let handlerError: string | null = null;
    for (const h of handlers) {
      try {
        const result = await h.handler(msg);
        if (result && 'transcript' in result && result.transcript.trim().length > 0) {
          transcript = result.transcript.trim();
          break;
        }
        if (result && 'error' in result && result.error && !handlerError) {
          handlerError = result.error;
        }
      } catch (e) {
        log.warn('voice handler failed', {
          mod: h.module,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    if (!transcript) {
      await ctx.reply(
        handlerError ??
          'Voice transcription is off for this chat. Turn it on with /voice on, or type your message.',
      );
      return;
    }

    await dispatchTextMessage(ctx, transcript);
  });

  // A photo/document carrying a `/dispatch <agent> <task>` caption drops that
  // file into the agent's run. grammY's command() doesn't match captions, so we
  // parse the caption here. Telegram puts an album's caption on its first item
  // only; the rest arrive caption-less and are ignored (single-file for now).
  const DISPATCH_CAPTION = /^\/dispatch(?:@\S+)?(?:\s+([\s\S]*))?$/;

  // Download a Telegram file id's bytes into memory (small inputs; the per-file
  // intake ceiling is enforced downstream by ingestFiles/MAX_ATTACHMENT_BYTES).
  const downloadFileBytes = async (fileId: string): Promise<Buffer> => {
    const file = await bot.api.getFile(fileId);
    if (!file.file_path) throw new Error('telegram file has no file_path');
    const link = `https://api.telegram.org/file/bot${opts.token}/${file.file_path}`;
    const res = await fetch(link, { redirect: 'follow' });
    if (!res.ok) throw new Error(`telegram file download failed: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  };

  const dispatchWithFile = async (
    ctx: Context,
    caption: string | undefined,
    file: { name: string; fileId: string; mime?: string },
  ): Promise<boolean> => {
    const m = caption ? DISPATCH_CAPTION.exec(caption.trim()) : null;
    if (!m) return false; // not a dispatch — let other handlers/none deal with it.
    if (!opts.agentRegistry || !opts.agentAttachmentsDir) {
      await ctx.reply('Agents are not available.');
      return true;
    }
    try {
      const bytes = await downloadFileBytes(file.fileId);
      const reply = await handleDispatchWithAttachments({
        registry: opts.agentRegistry,
        queue: opts.agentQueue,
        llm: opts.llm,
        baseDir: opts.agentAttachmentsDir,
        arg: m[1] ?? '',
        files: [{ name: file.name, bytes, ...(file.mime ? { mime: file.mime } : {}) }],
        notifyChatId: ctx.chat?.id ?? null,
      });
      await ctx.reply(reply);
    } catch (e) {
      log.warn('dispatch attachment failed', {
        error: e instanceof Error ? e.message : String(e),
      });
      await ctx.reply("Couldn't attach that file — try again, or dispatch without it.");
    }
    return true;
  };

  bot.on('message:photo', async (ctx) => {
    // Largest rendition is last; Telegram photos have no filename, so synthesize.
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    if (!photo) return;
    await dispatchWithFile(ctx, ctx.message.caption, {
      name: `photo_${photo.file_unique_id}.jpg`,
      fileId: photo.file_id,
      mime: 'image/jpeg',
    });
  });

  bot.on('message:document', async (ctx) => {
    const doc = ctx.message.document;
    await dispatchWithFile(ctx, ctx.message.caption, {
      name: doc.file_name ?? `document_${doc.file_unique_id}`,
      fileId: doc.file_id,
      ...(doc.mime_type ? { mime: doc.mime_type } : {}),
    });
  });

  bot.catch((err) => {
    log.error('grammy error', {
      error: err.error instanceof Error ? err.error.message : String(err.error),
    });
  });

  function buildAdvertisedCommands(): Array<{ command: string; description: string }> {
    const byName = new Map(CORE_COMMAND_DEFS.map((c) => [c.name, c]));
    return EVERYDAY_COMMANDS.map((name) => ({
      command: name,
      description: byName.get(name)?.advertised ?? name,
    }));
  }

  return {
    async start() {
      await bot.api
        .setMyCommands(buildAdvertisedCommands())
        .catch((e) => log.warn('setMyCommands failed', { error: String(e) }));
      log.info('telegram adapter starting (long-poll)');
      // bot.start() resolves only when the long-poll exits. Without a catch,
      // a network or grammY failure would leave the bot silently dead while
      // the rest of the process kept running.
      void bot
        .start({
          onStart: (info) => log.info('telegram bot connected', { username: info.username }),
        })
        .catch((e) => {
          log.error('telegram long-poll crashed', {
            error: e instanceof Error ? e.message : String(e),
          });
        });
    },
    async stop() {
      log.info('telegram adapter stopping');
      await bot.stop();
    },
    uptimeMs() {
      return Date.now() - startedAt;
    },
    async sendNudge(nudge) {
      try {
        const replyMarkup = keyboardForNudgeActions(nudge.actions);
        await bot.api.sendMessage(
          nudge.chatId,
          nudge.text,
          replyMarkup ? { reply_markup: replyMarkup } : undefined,
        );
      } catch (e) {
        log.warn('sendNudge failed', {
          chatId: nudge.chatId,
          category: nudge.category,
          priority: nudge.priority,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    },
    async sendMessage(chatId, text) {
      try {
        await bot.api.sendMessage(chatId, text);
      } catch (e) {
        log.warn('sendMessage failed', {
          chatId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    },
    async sendApprovalRequest(chatId, approval) {
      const keyboard = new InlineKeyboard()
        .text('✅ Yes', `agentapprove:${approval.id}:yes`)
        .text('❌ No', `agentapprove:${approval.id}:no`);
      const who = approval.agentName ? approval.agentName : `Task #${approval.taskId}`;
      // Plain text (no Markdown) so a tool name or reason with special
      // characters can't break the message.
      const text =
        `🔐 Approval needed\n\n` +
        `${who} wants to run "${approval.toolName}".\n\n` +
        `${approval.preview}`;
      try {
        await bot.api.sendMessage(chatId, text, { reply_markup: keyboard });
      } catch (e) {
        log.warn('sendApprovalRequest failed', {
          chatId,
          id: approval.id,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    },
    sendSkillProposal: pushSkillProposal,
    async sendVoice(chatId, voice) {
      try {
        const file = voice.path
          ? new InputFile(voice.path)
          : voice.data
            ? new InputFile(voice.data)
            : null;
        if (!file) {
          log.warn('sendVoice called without data or path', { chatId });
          return;
        }
        await bot.api.sendVoice(chatId, file, voice.caption ? { caption: voice.caption } : {});
      } catch (e) {
        log.warn('sendVoice failed', {
          chatId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    },
    confirmToolCall,
  };
}

// Split a reply into Telegram-sized pieces. Telegram rejects any single
// message over 4096 chars, and the orchestrator's reply path used to send the
// whole thing in one ctx.reply — so a long answer (notably a Codex handoff)
// was rejected by the API and silently dropped. We split at ~4000 chars,
// preferring a paragraph/line/space boundary near the limit so we don't cut a
// word in half. Returns at least one piece (possibly empty-string-safe).
const TELEGRAM_CHUNK = 4000;

export function splitForTelegram(text: string, limit = TELEGRAM_CHUNK): string[] {
  if (text.length <= limit) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    // Prefer to break at the last paragraph break, then newline, then space,
    // searching only the back half of the window so chunks stay reasonably full.
    let cut = window.lastIndexOf('\n\n');
    if (cut < limit * 0.5) cut = window.lastIndexOf('\n');
    if (cut < limit * 0.5) cut = window.lastIndexOf(' ');
    if (cut < limit * 0.5) cut = limit; // no good boundary — hard cut
    // Skip an all-whitespace chunk: pushing it would make the send loop call
    // ctx.reply('') which Telegram rejects with a 400, aborting the rest of a
    // long reply.
    const piece = rest.slice(0, cut).trimEnd();
    if (piece.length > 0) out.push(piece);
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) out.push(rest);
  // Guarantee a non-empty result even for pathological all-whitespace input.
  return out.length > 0 ? out : [text];
}

// Pure command handler for /quiet so it's directly testable. Returns the
// text the bot should reply with.
//
// Forms:
//   /quiet              — show current state
//   /quiet on           — pause indefinitely
//   /quiet off          — clear window + snooze
//   /quiet 1h | 30m     — snooze for that duration
//   /quiet 22:00-07:00  — set a daily window (start > end wraps midnight)
// /think and /fast resolve an argument to a sticky per-chat reasoning mode. Pure
// so it's testable without a DB: returns the mode for the caller to persist plus
// the reply text, or mode=null on an unrecognized argument (nothing persisted).
// A bare /think (empty arg) means "think about it" → 'on'.
const THINK_REPLIES: Record<ThinkMode, string> = {
  on: "Reasoning on. I'll think before answering — /fast for quicker replies.",
  off: "Fast mode on. I'll skip reasoning — /think to turn reasoning back on.",
  auto: "Reasoning set to auto (each model's default).",
};

export function handleThink(arg: string): { mode: ThinkMode | null; reply: string } {
  const a = arg.trim().toLowerCase();
  const mode: ThinkMode | null =
    a === '' ? 'on' : a === 'on' || a === 'off' || a === 'auto' ? a : null;
  if (mode === null) return { mode: null, reply: 'Usage: /think on | off | auto' };
  return { mode, reply: THINK_REPLIES[mode] };
}

export function handleQuiet(
  prefs: PrefsStore,
  chatId: number,
  arg: string,
  now: () => Date = () => new Date(),
): string {
  const a = arg.trim().toLowerCase();
  if (a === '') {
    const p = prefs.get(chatId);
    const check = prefs.isQuiet(chatId, now());
    const window = formatWindow(p.quietStartMinute, p.quietEndMinute);
    const lines = [`quiet: ${check.quiet ? 'on' : 'off'}`];
    if (window) lines.push(`daily window: ${window}`);
    if (p.pausedUntilMs && p.pausedUntilMs > now().getTime()) {
      lines.push(`snoozed until: ${new Date(p.pausedUntilMs).toLocaleString()}`);
    }
    lines.push('', 'Quiet hours: /quiet 22:00-07:00 · snooze: /quiet 1h · /quiet on|off');
    return lines.join('\n');
  }
  if (a === 'on') {
    // "on" with no duration means pause far enough into the future to be
    // effectively indefinite. The user can /quiet off to clear.
    prefs.setPausedUntil(chatId, now().getTime() + 100 * 365 * 24 * 60 * 60 * 1000);
    return 'quiet on (indefinite). /quiet off to resume.';
  }
  if (a === 'off') {
    prefs.clear(chatId);
    return 'quiet off.';
  }
  const dur = parseDuration(a);
  if (dur !== null) {
    const until = now().getTime() + dur;
    prefs.setPausedUntil(chatId, until);
    return `quiet on until ${new Date(until).toLocaleString()}.`;
  }
  const win = parseWindow(a);
  if (win !== null) {
    prefs.setQuietWindow(chatId, win.start, win.end);
    return `quiet window set: ${formatWindow(win.start, win.end)}.`;
  }
  return 'Usage: /quiet | on | off | <duration like 1h, 30m> | <window like 22:00-07:00>';
}

// /logs — read the tail of the configured log file. Reads at most the last
// 64 KB so a runaway log can't OOM the bot, then returns up to `lines`
// trailing non-empty lines. Telegram caps a message at 4096 chars; we
// truncate at ~3500 to leave room for the code-fence wrapper.
export function handleLogs(opts: { file: string; lines: number }): string {
  if (!existsSync(opts.file)) return `No log file at ${opts.file} yet.`;
  const MAX_BYTES = 64 * 1024;
  let text: string;
  let fd: number | undefined;
  try {
    fd = openSync(opts.file, 'r');
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - MAX_BYTES);
    const len = size - start;
    const buf = Buffer.allocUnsafe(len);
    readSync(fd, buf, 0, len, start);
    text = buf.toString('utf8');
  } catch (e) {
    return `Could not read log: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const all = text.split('\n').filter((l) => l.length > 0);
  const tail = all.slice(-opts.lines);
  let out = tail.join('\n');
  const MAX_REPLY = 3500;
  if (out.length > MAX_REPLY) {
    out = '…\n' + out.slice(out.length - MAX_REPLY);
  }
  return out || '(log is empty)';
}
