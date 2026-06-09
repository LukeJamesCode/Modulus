// Two-queue orchestrator. Owns the conversation pipeline.
//
//  user-facing queue   — per chat, FIFO, one in-flight reply at a time. The
//                        Telegram adapter calls handleUserMessage(); the
//                        orchestrator serializes per-chat work, makes /stop
//                        possible via AbortController, and streams the LLM
//                        reply back through the supplied sink.
//  after-turn hooks    — the Telegram adapter forwards post-turn metadata to
//                        extensions after the visible reply is done, so
//                        learning/routine work stays off the hot path.

import type { DB } from '../storage/db.js';
import type { Logger } from '../util/log.js';
import type { LLM, ChatChunk, ProfileName, ThinkMode, ToolCall } from './llm.js';
import { LLMEmptyResponseError, LLMHttpError } from './llm.js';

// The 0.8b/2b chat models occasionally answer a tool-routed question by
// PRINTING what a tool call looks like as plain text, instead of using the
// structured tool-call protocol. Three shapes have been observed in
// abilitytest output:
//   1. Markdown JSON block: ```json { "type": "briefing_tomorrow", ... } ```
//   2. Bracketed/backticked tool name: `[tasks_list]`, `` `reminder_set` at 15:00 ``
//   3. Function-call shape: `` `tasks_add` with `title`: "Buy milk" `` or
//      `ask_task("buy_milk")`
//
// When we see one of these AND the model emitted no real tool calls this
// round, we treat the assistant text as empty so the existing safety net
// re-runs the turn with tools disabled. That forces the model to answer in
// natural language (e.g. "I can't help with that") instead of leaving the
// user with a corrupted tool-call-shaped reply.
export function looksLikeFakeToolCall(text: string, allowedTools: ReadonlySet<string>): boolean {
  const t = text.trim();
  if (!t) return false;
  // Shape 1: markdown JSON block with a `"type": "<tool_name>"` or `"name": "<tool_name>"` field.
  const jsonBlock =
    /^```(?:json)?\s*\n?\s*\{[\s\S]{0,400}?"(?:type|name)"\s*:\s*"([a-z_][a-z0-9_]*)"/i.exec(t);
  if (jsonBlock && allowedTools.has(jsonBlock[1]!)) return true;
  // Shape 2/3: a recognised tool name in brackets, backticks, or as a
  // function call at (or very near) the start of the reply.
  const head = t.slice(0, 120);
  const refMatch =
    /^[\s*_>]*[[`]\s*([a-z_][a-z0-9_]*)\s*[\]`]/i.exec(head) ??
    // Require the parenthesis to actually look like a call — an empty arg list,
    // a quoted/braced literal, or a `key=`/`key:` argument — so a tool named
    // like a common word doesn't blank a reply that merely opens a prose
    // parenthetical (e.g. "weather (in Celsius) is mild").
    /^[\s*_>]*`?([a-z_][a-z0-9_]*)`?\s*\(\s*(?:\)|["'{]|[a-z_]\w*\s*[:=])/i.exec(head);
  if (refMatch && allowedTools.has(refMatch[1]!)) return true;
  return false;
}

// Ollama returns HTTP 500 with an XML/JSON parse error message when the model
// emits a malformed tool-call payload that its parser can't decode. This is
// not a backend outage — it's a model misfire, so we recover the same way we
// recover from an empty response: retry once with tools disabled.
function isMalformedToolCallError(e: unknown): boolean {
  if (!(e instanceof LLMHttpError)) return false;
  if (e.status !== 500) return false;
  const m = e.message.toLowerCase();
  return (
    m.includes('xml syntax error') ||
    m.includes('parameter') ||
    m.includes('function call') ||
    m.includes('tool call') ||
    m.includes('parse')
  );
}
import { toSchema, type ToolRegistry } from './tools.js';
import { build as buildContext, type HistoryMessage } from './context.js';
import type { AfterTurnContext, AfterTurnToolCallSummary, TurnGuard } from './extensions.js';

// Cap on how much of a tool's output we re-feed to the model on the next
// round. Verbose tool output (a 5KB web-search dump, a 30-event calendar
// listing) otherwise blows the chat profile's 4096-token budget for several
// turns — atlas hit this exact failure mode and pinned the cap at 2000.
// The truncation marker is appended so the model can tell its context was
// clipped and ask the user / re-query if it really needs the rest.
export const TOOL_RESULT_MAX_CHARS = 2000;
const TOOL_RESULT_TRUNCATION_MARKER = '\n…[truncated]';
export const AFTER_TURN_TOOL_RESULT_SUMMARY_MAX_CHARS = 500;

export interface ReplyChunk {
  delta: string;
  // Delta of the model's reasoning, when a thinking-capable model is run with
  // reasoning enabled. A separate channel from `delta` so the adapter can show
  // it as collapsible "thinking" without it ever contaminating the answer or
  // the persisted assistant text.
  thinking?: string;
  done: boolean;
  // When set, the adapter should discard the streamed buffer for this turn
  // and render this string in its place. Used by the hallucination guard to
  // overwrite an "I removed that for you" plaintext claim that wasn't backed
  // by an actual delete-tool call. Only honoured on the final (done) chunk.
  replace?: string;
  // Set once on the final chunk.
  meta?: {
    model: string;
    promptTokens?: number;
    completionTokens?: number;
    elapsedMs: number;
    afterTurn?: AfterTurnContext;
  };
}

export interface UserMessage {
  chatId: number;
  userId: number;
  text: string;
  // Sink for streamed reply chunks. The Telegram adapter wires this to a
  // chunked-edit Telegram message.
  send: (chunk: ReplyChunk) => void | Promise<void>;
  // Per-turn override of the model's thinking mode (the panel's think toggle).
  // Overrides the orchestrator's defaultThinkMode and the profile default.
  thinkMode?: ThinkMode;
  // Base64 images to attach to THIS user turn for a multimodal model (agent task
  // image attachments). Ride the initial model call only; not persisted to
  // history. Callers must have gated on LLM.supportsVision already.
  images?: string[];
}

export interface OrchestratorOptions {
  db: DB;
  llm: LLM;
  tools: ToolRegistry;
  log: Logger;
  systemPrompt?: string;
  defaultProfile?: ProfileName;
  // Profile to use for chat calls that include tool schemas. Falls back to
  // defaultProfile when unset, so deployments that haven't configured a
  // dedicated tool-use model keep their old behaviour.
  toolProfile?: ProfileName;
  // Default thinking mode for every turn this orchestrator runs, unless a
  // UserMessage overrides it. Used by per-agent think settings; left unset for
  // the main bot, which relies on the profile/auto default.
  defaultThinkMode?: ThinkMode;
  budgetTokens?: number;
  // Per-inference timeout (ms) applied to every llm.chat call this orchestrator
  // makes, overriding the LLM instance default. Unset keeps the LLM default
  // (120s). Agents set this high so a slow model (e.g. a 12B research round on
  // CPU) isn't killed mid-inference and mistaken for a cancellation.
  inferenceTimeoutMs?: number;
  // Cap on how many chars of a tool's output are re-fed to the model on the
  // next round. Defaults to TOOL_RESULT_MAX_CHARS. Scaled up on larger tiers
  // where the context window can hold richer tool output without crowding out
  // history. See src/cli/profiles.ts.
  toolResultMaxChars?: number;
  // Cap on chained tool-call rounds per user turn. qwen3.5:0.8b is over-eager
  // about tool-calling, so the orchestrator needs both a real loop (single
  // round wasn't enough — chained calls left assistantText empty) and a hard
  // stop so it can't spin forever. Surface as a config knob because long
  // calendar conflict resolution can want 5–6 rounds while plain Q&A bots
  // want 2.
  maxToolRounds?: number;
  // Returns the concatenated prompt fragments contributed by extensions.
  // Called fresh on each turn so hot-reloaded extensions show up without an
  // orchestrator restart. The filter (when supplied) limits the fragments to
  // a subset of extensions — used to keep the system prompt aligned with the
  // intent-pruned tool manifest.
  promptFragmentProvider?: (extensionFilter?: ReadonlySet<string>) => string;
  // Per-turn intent filter for the tool manifest. Returns the names of
  // extensions whose tools should be exposed to the model for this message,
  // or null to expose every tool (legacy behaviour). An empty array means
  // "no tools" — used for trivial chatter like "hi", "thanks".
  // Without this provider, the orchestrator always exposes every tool.
  toolIntentFilter?: (message: string) => string[] | null;
  // Returns the long-term memory block recalled for this turn's user message,
  // or undefined when nothing relevant is stored. Fills the `memory` slot of
  // the deterministic prefix (system → tools → memory → session → history).
  // Shared across the main chat and every agent run — the hive-mind store
  // (src/core/memory.ts) is the canonical provider, wired in start.ts.
  memoryProvider?: (message: string) => string | undefined;
  // Whether deterministic tool auto-routing (a tool's `autoRoute` hook claiming
  // the turn before the model runs) is honoured. Defaults to true for the main
  // chat, where it compensates for a tiny model that won't reliably escalate.
  // Agent runs set this false: an agent is an explicitly configured persona
  // with its own model and tool grant, so a global autoRoute (e.g. codex
  // escalating on the word "research") must not hijack its turn.
  autoRouteEnabled?: boolean;
  // Post-turn reply guards. Called fresh each turn (so hot-reloaded extensions
  // show up without an orchestrator restart) to get the active guard list. Each
  // guard may overwrite the finalized reply — used to catch domain-specific
  // hallucinations (e.g. "I deleted it" with no destructive tool call). First
  // guard to return a non-null replacement wins. Unset → no guards run, which is
  // the right default for agent orchestrators and tests.
  turnGuards?: () => TurnGuard[];
}

export interface Orchestrator {
  handleUserMessage(msg: UserMessage): Promise<void>;
  stop(chatId: number): boolean;
  // Reset the conversation for a chat. Closes the current conversation row
  // and leaves the next message to open a fresh one.
  newChat(chatId: number): void;
  lastError(chatId: number): string | undefined;
  // Stop accepting new work, wait for in-flight chats to finish.
  shutdown(): Promise<void>;
}

interface ChatSlot {
  // Pending messages in arrival order. The head is in flight.
  queue: QueuedUserMessage[];
  inFlight: boolean;
  abort: AbortController | null;
}

interface QueuedUserMessage extends UserMessage {
  resolve: () => void;
  reject: (error: unknown) => void;
}

const DEFAULT_SYSTEM = `You are Modulus, a concise AI assistant chatting with the user over Telegram. When the user asks you to do something you have a tool for, call the tool — never tell the user to do it themselves. Be direct.`;
const DEFAULT_MAX_TOOL_ROUNDS = 4;

// Per-turn world-state anchor injected at the end of the system prompt. Two
// jobs:
//
// 1. Date math. The model needs an explicit "today is X" to resolve relative
//    phrases like "tomorrow" or "may 5th" into ISO timestamps for tools.
//    Tomorrow's date is included because small models (0.8b) routinely got
//    the math wrong when only TODAY was anchored — "tomorrow at 9" would land
//    on the day after tomorrow because the model second-guessed its own date
//    arithmetic. Atlas added the explicit tomorrow anchor and it eliminated
//    that whole class of off-by-ones.
//
// 2. Temporal awareness. Current local time + time-since-last-user-message
//    let the model behave like an agent that *exists in time* rather than a
//    stateless responder. "I see it's been three days since we last talked"
//    or "good evening" only work if the model is told the wall clock and the
//    gap. The cost is tiny (one extra line of prompt) and the cache penalty
//    is minutes-granular, so the prefix only invalidates once a minute.
//
// `lastUserAt` is the timestamp of the *previous* user message in this
// conversation, in epoch ms. Undefined means this is the first turn.
function dailyContext(now: Date = new Date(), lastUserAt?: number): string {
  // Round to the nearest 5 minutes so Ollama's KV slot cache survives across
  // turns within the same 5-minute window. The previous behaviour included
  // wall-clock minutes in the system prompt, which busted the cache every 60s
  // for no user-visible benefit — the model never actually needed sub-5-min
  // precision and the cost on a Pi is real (each cache miss re-runs prompt
  // eval over the whole system block).
  const FIVE_MIN_MS = 5 * 60 * 1000;
  const rounded = new Date(Math.floor(now.getTime() / FIVE_MIN_MS) * FIVE_MIN_MS);
  const tzMin = -rounded.getTimezoneOffset();
  const sign = tzMin >= 0 ? '+' : '-';
  const tzh = String(Math.floor(Math.abs(tzMin) / 60)).padStart(2, '0');
  const tzm = String(Math.abs(tzMin) % 60).padStart(2, '0');
  const offset = `${sign}${tzh}:${tzm}`;
  const isoDate = isoDay(rounded);
  const weekday = rounded.toLocaleDateString('en-US', { weekday: 'long' });
  const hh = String(rounded.getHours()).padStart(2, '0');
  const mm = String(rounded.getMinutes()).padStart(2, '0');
  // Derive tomorrow/yesterday from `rounded`, not the raw clock: within the
  // first few minutes after local midnight the 5-minute floor can land on the
  // previous calendar day, and mixing the two bases would emit an inconsistent
  // anchor block (e.g. "Today: Monday … Tomorrow: Wednesday").
  const tomorrow = new Date(rounded.getTime());
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowIso = isoDay(tomorrow);
  const tomorrowWeekday = tomorrow.toLocaleDateString('en-US', { weekday: 'long' });
  const yesterday = new Date(rounded.getTime());
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayIso = isoDay(yesterday);
  const yesterdayWeekday = yesterday.toLocaleDateString('en-US', { weekday: 'long' });
  const sinceLine =
    lastUserAt !== undefined
      ? ` Time since the user's previous message: ${humanGap(now.getTime() - lastUserAt)}.`
      : ' This is the first message in the conversation.';
  // The "authoritative clock" wording exists because qwen3.5:0.8b would
  // otherwise paraphrase or invent times when asked "what time is it" — it
  // saw the date line as flavour text, not a fact to report. Telling it
  // explicitly to quote these values fixes that. Yesterday is included for
  // the same off-by-one reason as tomorrow (see header comment).
  return (
    `Current local time: ${weekday} ${isoDate} ${hh}:${mm} (offset ${offset}). ` +
    `Today: ${weekday} ${isoDate}. Tomorrow: ${tomorrowWeekday} ${tomorrowIso}. Yesterday: ${yesterdayWeekday} ${yesterdayIso}.` +
    sinceLine +
    ` This line is the authoritative source for the current date and time. When the user asks what time it is, what day it is, what today/tomorrow/yesterday is, or any date-related question, answer using these exact values — do not estimate, round, or invent. Use the same dates and offset when constructing ISO 8601 timestamps for tool arguments (e.g. resolving "today", "tomorrow", or "may 5th").`
  );
}

// Render a millisecond gap as a short human phrase the model can read. Kept
// coarse on purpose — exact seconds add noise to the prompt and don't change
// behaviour. Negative or zero gaps (clock skew, same-millisecond) collapse to
// "just now".
// Bucketed so the system prompt prefix changes rarely — every per-second tick
// in this string invalidates Ollama's KV prompt cache on the next turn, which
// on CPU costs full prefill on the next call. The model only needs coarse
// "how long since the user talked to me" awareness; precise seconds add no
// agent-side value.
export function humanGap(ms: number): string {
  if (ms < 2 * 60_000) return 'just now';
  if (ms < 15 * 60_000) return 'a few minutes';
  if (ms < 60 * 60_000) return 'under an hour';
  const hr = Math.floor(ms / (60 * 60_000));
  if (hr < 24) return hr === 1 ? 'about an hour' : `${hr} hours`;
  const day = Math.floor(hr / 24);
  return day === 1 ? 'a day' : `${day} days`;
}

function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Truncate a tool's output before it gets re-injected into the model's
// context. Long outputs blow the prompt budget for several turns; the
// marker tells the model the trailing bytes were dropped so it can ask
// the user to narrow the query if needed.
export function truncateToolResult(output: string, max: number = TOOL_RESULT_MAX_CHARS): string {
  if (output.length <= max) return output;
  // Keep the head; trailing context is usually less informative for the
  // small chat model. Marker is appended *after* the slice so the total
  // length stays close to `max`.
  return output.slice(0, max) + TOOL_RESULT_TRUNCATION_MARKER;
}

function summarizeToolResult(output: string): string {
  return truncateToolResult(output, AFTER_TURN_TOOL_RESULT_SUMMARY_MAX_CHARS);
}

export function createOrchestrator(opts: OrchestratorOptions): Orchestrator {
  const log = opts.log.child({ mod: 'orchestrator' });
  const systemPrompt = opts.systemPrompt ?? DEFAULT_SYSTEM;
  const defaultProfile: ProfileName = opts.defaultProfile ?? 'chat';
  // Resolve once at startup. If `toolProfile` was passed but isn't actually
  // configured on the LLM, fall back to defaultProfile so we don't crash on
  // first turn.
  const toolProfile: ProfileName = (() => {
    const requested = opts.toolProfile ?? defaultProfile;
    if (requested === defaultProfile) return defaultProfile;
    const profiles = opts.llm.listProfiles();
    return profiles[requested] ? requested : defaultProfile;
  })();
  // Profile to escalate to when the tiny model fails to produce a usable reply
  // (empty stream, garbled/fake tool-call text, or a malformed tool call Ollama
  // rejects). Prefer the heavy `reason` model when one is configured: this is
  // the only place the main chat path reaches the 9B, and it's exactly the
  // moment quality has already failed, so spending one cold load is justified.
  // Falls back to defaultProfile on hosts with no reason model (Small tier),
  // making escalation a no-op there. Resolved once — profiles are static for
  // the process.
  const escalationProfile: ProfileName = opts.llm.listProfiles().reason ? 'reason' : defaultProfile;
  const budgetTokens = opts.budgetTokens ?? 4096;
  const toolResultMaxChars = opts.toolResultMaxChars ?? TOOL_RESULT_MAX_CHARS;
  const maxToolRounds = opts.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
  const autoRouteEnabled = opts.autoRouteEnabled ?? true;

  const slots = new Map<number, ChatSlot>();
  const lastErrors = new Map<number, string>();
  let shuttingDown = false;

  function getSlot(chatId: number): ChatSlot {
    let s = slots.get(chatId);
    if (!s) {
      s = { queue: [], inFlight: false, abort: null };
      slots.set(chatId, s);
    }
    return s;
  }

  // --- conversation persistence -------------------------------------------
  //
  // Prepared statements hoisted so better-sqlite3 reuses the compiled query
  // across every turn instead of re-parsing on each call. Lazy because some
  // tests construct an orchestrator against a fresh DB and we want any schema
  // errors to surface on first use, not at module load.

  type Stmt = {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { lastInsertRowid: number | bigint; changes: number };
  };
  let stmts: {
    selectCurrentConversation: Stmt;
    insertConversation: Stmt;
    upsertChat: Stmt;
    selectHistory: Stmt;
    insertMessage: Stmt;
    selectLastUserAt: Stmt;
  } | null = null;
  function getStmts(): NonNullable<typeof stmts> {
    if (stmts) return stmts;
    stmts = {
      selectCurrentConversation: opts.db.prepare(
        `SELECT current_conversation_id AS id FROM telegram_chats WHERE chat_id = ?`,
      ),
      insertConversation: opts.db.prepare(
        `INSERT INTO conversations (telegram_chat_id, started_at) VALUES (?, ?)`,
      ),
      upsertChat: opts.db.prepare(
        `INSERT INTO telegram_chats (chat_id, user_id, current_conversation_id, last_seen_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET
           current_conversation_id = excluded.current_conversation_id,
           user_id = excluded.user_id,
           last_seen_at = excluded.last_seen_at`,
      ),
      // LIMIT 500: defense in depth against a runaway conversation. The
      // context manager already truncates to the prompt budget further down;
      // this is the OOM safety net for a chat that somehow accumulated
      // millions of rows. Ordered DESC then reversed so we get the most
      // recent 500 messages, not the oldest 500.
      selectHistory: opts.db.prepare(
        `SELECT role, content, tool_call_id, tool_name, tool_calls_json FROM messages
         WHERE conversation_id = ? ORDER BY id DESC LIMIT 500`,
      ),
      insertMessage: opts.db.prepare(
        `INSERT INTO messages (conversation_id, role, content, tool_call_id, tool_name, tool_calls_json, tokens, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      selectLastUserAt: opts.db.prepare(
        `SELECT created_at AS t FROM messages
         WHERE conversation_id = ? AND role = 'user'
         ORDER BY id DESC LIMIT 1`,
      ),
    };
    return stmts;
  }

  function ensureConversation(chatId: number, userId: number): number {
    const s = getStmts();
    const row = s.selectCurrentConversation.get(chatId) as { id: number | null } | undefined;
    if (row?.id) return row.id;
    const ins = s.insertConversation.run(chatId, Date.now());
    const conversationId = Number(ins.lastInsertRowid);
    s.upsertChat.run(chatId, userId, conversationId, Date.now());
    return conversationId;
  }

  function loadHistory(conversationId: number): HistoryMessage[] {
    const rows = getStmts().selectHistory.all(conversationId) as Array<{
      role: HistoryMessage['role'];
      content: string;
      tool_call_id: string | null;
      tool_name: string | null;
      tool_calls_json: string | null;
    }>;
    rows.reverse();
    return rows.map((r) => {
      const m: HistoryMessage = { role: r.role, content: r.content };
      if (r.tool_call_id) m.tool_call_id = r.tool_call_id;
      if (r.tool_name) m.tool_name = r.tool_name;
      if (r.tool_calls_json) {
        try {
          m.tool_calls = JSON.parse(r.tool_calls_json);
        } catch {
          // ignore malformed JSON
        }
      }
      return m;
    });
  }

  function appendMessage(
    conversationId: number,
    role: HistoryMessage['role'],
    content: string,
    extra: {
      tool_call_id?: string;
      tool_name?: string;
      tokens?: number;
      tool_calls?: ToolCall[];
    } = {},
  ): void {
    getStmts().insertMessage.run(
      conversationId,
      role,
      content,
      extra.tool_call_id ?? null,
      extra.tool_name ?? null,
      extra.tool_calls ? JSON.stringify(extra.tool_calls) : null,
      extra.tokens ?? null,
      Date.now(),
    );
  }

  // Most-recent user-message timestamp in this conversation. Undefined when
  // the conversation has no user messages yet (first turn). Called *before*
  // we append the current turn so the value reflects the previous turn.
  function lastUserMessageTimestamp(conversationId: number): number | undefined {
    const row = getStmts().selectLastUserAt.get(conversationId) as { t: number } | undefined;
    return row?.t;
  }

  // --- user-facing pipeline -----------------------------------------------

  async function process(msg: UserMessage, slot: ChatSlot): Promise<void> {
    const startedAt = Date.now();
    const cl = log.child({ chatId: msg.chatId });
    const conversationId = ensureConversation(msg.chatId, msg.userId);
    // Capture the previous user message's timestamp BEFORE we insert the
    // current one — feeds the world-state ticker so the model can read "the
    // user last spoke 3 hours ago" and behave accordingly. Undefined on the
    // first turn of a conversation.
    const lastUserAt = lastUserMessageTimestamp(conversationId);
    appendMessage(conversationId, 'user', msg.text);

    // Track history in memory and append-as-we-persist so we don't reload
    // the entire conversation from SQLite on every tool round (was: 1 load
    // up front + 1 load per followup + 1 load per safety-net retry).
    const history = loadHistory(conversationId);
    // Pending DB writes for this round. Buffering + flushing in one
    // transaction means a crash mid-round (e.g. SIGTERM after writing the
    // assistant's tool-call request but before its tool results land) can no
    // longer leave the conversation with orphan rows that confuse the next
    // load. Writes always go into `history` immediately so the in-flight LLM
    // call still sees a consistent in-memory view.
    type PendingWrite = {
      role: HistoryMessage['role'];
      content: string;
      extra: {
        tool_call_id?: string;
        tool_name?: string;
        tokens?: number;
        tool_calls?: ToolCall[];
      };
    };
    let pendingRound: PendingWrite[] = [];
    const flushRound = (): void => {
      if (pendingRound.length === 0) return;
      const batch = pendingRound;
      pendingRound = [];
      opts.db.transaction(() => {
        for (const w of batch) appendMessage(conversationId, w.role, w.content, w.extra);
      })();
    };
    const trackingAppend = (
      role: HistoryMessage['role'],
      content: string,
      extra: {
        tool_call_id?: string;
        tool_name?: string;
        tokens?: number;
        tool_calls?: ToolCall[];
      } = {},
    ): void => {
      pendingRound.push({ role, content, extra });
      const entry: HistoryMessage = { role, content };
      if (extra.tool_call_id) entry.tool_call_id = extra.tool_call_id;
      if (extra.tool_name) entry.tool_name = extra.tool_name;
      if (extra.tool_calls) entry.tool_calls = extra.tool_calls;
      history.push(entry);
    };

    // Compute intent up front so both the prompt fragment and the tool
    // manifest below filter on the same set.
    const intent = opts.toolIntentFilter?.(msg.text) ?? null;
    const intentSet = intent && intent.length > 0 ? new Set(intent) : undefined;
    const toolPrompt = opts.promptFragmentProvider?.(intentSet) || undefined;
    // Recall failure must never block a turn — memory is an enrichment, and a
    // corrupt FTS index degrading to "no memories" is the right failure mode.
    let memory: string | undefined;
    try {
      memory = opts.memoryProvider?.(msg.text) || undefined;
    } catch (e) {
      cl.warn('memory provider failed', { error: e instanceof Error ? e.message : String(e) });
    }
    const systemForTurn = `${systemPrompt}\n\n${dailyContext(new Date(), lastUserAt)}`;

    // One helper, three callers: initial chat, tool-loop followup, safety-net
    // followup. Optional `omitToolPrompt` lets the safety net drop the tool
    // fragment so the model isn't told about tools that aren't on the wire.
    const buildPromptForTurn = (omitToolPrompt = false) =>
      buildContext({
        systemPrompt: systemForTurn,
        history,
        ...(!omitToolPrompt && toolPrompt ? { toolPrompt } : {}),
        ...(memory ? { memory } : {}),
        budgetTokens,
      });

    const built = buildPromptForTurn();
    if (built.truncated) cl.debug('history truncated to fit budget');

    // Attach this turn's images to the last user message for the initial model
    // call. Tool-loop follow-ups rebuild from text-only history, so images ride
    // the first round only — which is what a vision model needs to ground on.
    if (msg.images && msg.images.length > 0) {
      for (let i = built.messages.length - 1; i >= 0; i--) {
        if (built.messages[i]!.role === 'user') {
          built.messages[i] = { ...built.messages[i]!, images: msg.images };
          break;
        }
      }
    }

    const abort = new AbortController();
    slot.abort = abort;

    // Tool manifest pruning. Pruning by message intent cuts prompt size
    // dramatically on every tool round — Ollama re-sends the schema block on
    // each follow-up, so over a 2-round tool flow the savings compound. Falls
    // back to all tools when no filter is wired or the filter can't decide.
    let toolSchemas =
      intent === null
        ? opts.tools.schemas()
        : intentSet === undefined
          ? []
          : opts.tools.schemasFor(intentSet, msg.text);
    if (intent && intent.length > 0) {
      cl.debug('tool manifest pruned by intent', {
        kept: toolSchemas.length,
        extensions: intent,
      });
    } else if (intent && intent.length === 0) {
      cl.debug('tool manifest skipped — message looks like trivial chatter');
    }

    // Deterministic auto-routing. A tool can claim a turn outright via its
    // `autoRoute` hook (e.g. modulus-codex escalating a clearly-hard task), so
    // escalation doesn't hinge on a tiny model choosing to call it. The forced
    // call still runs through execute() below — confirm tier and all — and a
    // selfReplying tool ships its answer directly. First match wins; only one
    // tool is expected to claim a given message.
    let forcedCall: ToolCall | null = null;
    for (const h of autoRouteEnabled ? opts.tools.list() : []) {
      if (!h.autoRoute) continue;
      let args: Record<string, unknown> | null = null;
      try {
        args = h.autoRoute(msg.text);
      } catch (e) {
        cl.warn('tool autoRoute threw; ignoring', {
          tool: h.name,
          error: e instanceof Error ? e.message : String(e),
        });
      }
      if (args) {
        forcedCall = { id: `auto_${Date.now()}`, name: h.name, arguments: args };
        // Make sure the forced tool is the per-turn allowed set so the loop's
        // schema gate (allowedToolNames) admits it even if intent pruning
        // wouldn't have surfaced it.
        toolSchemas = [toSchema(h)];
        cl.info('turn auto-routed to tool', { tool: h.name });
        break;
      }
    }
    let assistantText = '';
    let lastChunk: ChatChunk | null = null;
    const afterTurnToolCalls: AfterTurnToolCallSummary[] = [];

    // Drains one streamed chat round into msg.send + assistantText. Returns
    // the final chunk so the caller can inspect tool_calls / usage.
    const drain = async (s: AsyncIterable<ChatChunk>): Promise<ChatChunk | null> => {
      let final: ChatChunk | null = null;
      // Ollama streams tool calls on their own chunk (done=false, empty
      // content) and then ships a separate done=true chunk with no tool_calls.
      // If we only kept `final`, the tool calls would be lost — the orchestrator
      // would skip the tool loop and the user would see "(no reply)".
      let pendingToolCalls: ToolCall[] | undefined;
      for await (const chunk of s) {
        final = chunk;
        if (chunk.toolCalls && chunk.toolCalls.length > 0) {
          pendingToolCalls = chunk.toolCalls;
        }
        // Forward the delta whether or not this is the done chunk — Ollama
        // sometimes ships the last token alongside done=true, and dropping it
        // gave the Telegram adapter an empty buffer (→ "(no reply)").
        if (chunk.delta) {
          assistantText += chunk.delta;
          await msg.send({ delta: chunk.delta, done: false });
        }
        // Reasoning rides its own channel — forwarded to the adapter but never
        // accumulated into assistantText (which becomes the persisted answer).
        if (chunk.thinking) {
          await msg.send({ delta: '', thinking: chunk.thinking, done: false });
        }
        if (chunk.done) break;
      }
      if (final && pendingToolCalls && (!final.toolCalls || final.toolCalls.length === 0)) {
        final = { ...final, toolCalls: pendingToolCalls };
      }
      return final;
    };

    // Per-turn thinking mode: the message's explicit toggle wins, else the
    // orchestrator's configured default (per-agent). Undefined leaves the LLM
    // to fall back to the profile/auto default. Spread into every llm.chat call
    // below so a forced think/no-think holds across tool-loop followups too.
    const turnThinkMode: ThinkMode | undefined = msg.thinkMode ?? opts.defaultThinkMode;
    // Per-inference timeout knob (agents set this high so a slow model isn't
    // killed mid-round). Folded into the option bundles below so it rides every
    // llm.chat call this turn makes — initial, tool-loop followup, and both
    // recovery retries.
    const timeoutOpt = opts.inferenceTimeoutMs ? { timeoutMs: opts.inferenceTimeoutMs } : {};
    const thinkOpt = { ...(turnThinkMode ? { thinkMode: turnThinkMode } : {}), ...timeoutOpt };
    // Recovery retries (the empty-text safety net and the empty-response catch
    // below) force thinking OFF. A reasoning model that produced only hidden
    // `thinking` and no visible answer — typically because it exhausted
    // num_predict mid-thought — would repeat that exact miss if retried with
    // thinking still on, leaving the turn silent. Forcing plain language
    // guarantees a usable answer. For a model that can't think this is a no-op
    // (llm.ts never sends `think` to such a model).
    const recoveryThinkOpt = { thinkMode: 'off' as const, ...timeoutOpt };
    // One recovery shape, shared by both fallbacks: the post-loop empty-text
    // safety net and the empty-response/malformed-tool-call catch. Re-ask on the
    // escalation profile with tools off (buildPromptForTurn(true) also drops the
    // tool-prompt fragment) and thinking forced off, so the model is made to
    // answer in plain language. Kept as one closure so a fix to the retry can't
    // drift between the two call sites.
    const retryWithToolsOff = (): AsyncIterable<ChatChunk> =>
      opts.llm.chat({
        profile: escalationProfile,
        messages: buildPromptForTurn(true).messages,
        ...recoveryThinkOpt,
        signal: abort.signal,
        context: { chatId: msg.chatId, conversationId },
      });
    try {
      const profileForTurn: ProfileName = toolSchemas.length > 0 ? toolProfile : defaultProfile;
      if (forcedCall) {
        // Skip the model entirely: synthesize the tool-call chunk so the tool
        // loop below executes the forced call (through confirm + selfReplying)
        // exactly as if the model had asked for it.
        lastChunk = { delta: '', done: true, toolCalls: [forcedCall] };
      } else {
        cl.debug('selected model profile', { profile: profileForTurn });
        const initial = opts.llm.chat({
          profile: profileForTurn,
          messages: built.messages,
          ...(toolSchemas.length > 0 ? { tools: toolSchemas } : {}),
          ...thinkOpt,
          signal: abort.signal,
          context: { chatId: msg.chatId, conversationId },
        });
        lastChunk = await drain(initial);

        // Fake-tool-call sanitizer (initial round). If the model wrote
        // tool-call-shaped text instead of emitting a real tool call, clear
        // the accumulated reply so the empty-text safety net kicks in and
        // retries with tools off. Keeps the user from seeing replies like
        // `[tasks_list]` or ```json {"type":"briefing_tomorrow"}```.
        if (
          assistantText &&
          !(lastChunk?.toolCalls && lastChunk.toolCalls.length > 0) &&
          toolSchemas.length > 0
        ) {
          const allowed = new Set(toolSchemas.map((s) => s.function.name));
          if (looksLikeFakeToolCall(assistantText, allowed)) {
            cl.warn('model emitted fake tool-call as plain text — retrying with tools off', {
              sample: assistantText.slice(0, 120),
            });
            assistantText = '';
          }
        }
      }

      let round = 0;
      while (lastChunk?.toolCalls && lastChunk.toolCalls.length > 0) {
        if (round >= maxToolRounds) {
          cl.warn('tool-call loop hit max rounds — forcing a no-tools final reply', {
            round,
            maxToolRounds,
          });
          break;
        }
        round += 1;
        cl.debug('handling tool calls', {
          round,
          n: lastChunk.toolCalls.length,
          names: lastChunk.toolCalls.map((c) => c.name),
        });
        const allowedToolNames = new Set(toolSchemas.map((s) => s.function.name));
        const willShortCircuit = lastChunk.toolCalls.every((call) => {
          if (!allowedToolNames.has(call.name)) return false;
          return opts.tools.get(call.name)?.selfReplying === true;
        });

        // Persist the assistant turn that requested the tool calls.
        if (!willShortCircuit) {
          if (assistantText || lastChunk.toolCalls.length > 0) {
            trackingAppend('assistant', assistantText || '', { tool_calls: lastChunk.toolCalls });
          }
        }
        // Track whether every tool in this round is self-replying. When all
        // are, the orchestrator can ship the concatenated tool outputs as
        // the final reply and skip the follow-up LLM round-trip — that round
        // is otherwise spent re-phrasing "Added: <event>" into "I added the
        // event!", which doubles wall-clock for an action turn.
        let allSelfReplying = true;
        const selfReplyingOutputs: string[] = [];
        // Per-turn dispatch gate. The registry's execute() looks up handlers
        // by global name, so a small model can bypass intent pruning entirely
        // by emitting a name it memorized in training. That defeats the whole
        // pruning strategy and routes "Plan my day" to briefing_today,
        // "Cancel the camping event" to tasks_complete, etc. Enforce the
        // per-turn schema as the source of truth for what's callable.
        for (const call of lastChunk.toolCalls) {
          if (!allowedToolNames.has(call.name)) {
            const available = allowedToolNames.size
              ? [...allowedToolNames].join(', ')
              : '(none — this turn does not expose any tools)';
            const rejectionMsg = `Tool '${call.name}' is not available for this turn. Available tools: ${available}. Pick one of those or answer in plain text.`;
            cl.warn('rejected tool call outside per-turn schema', {
              name: call.name,
              allowedCount: allowedToolNames.size,
            });
            afterTurnToolCalls.push({
              name: call.name,
              arguments: call.arguments,
              ok: false,
              resultSummary: summarizeToolResult(rejectionMsg),
            });
            trackingAppend('tool', rejectionMsg, {
              tool_call_id: call.id,
              tool_name: call.name,
            });
            allSelfReplying = false;
            continue;
          }
          const handler = opts.tools.get(call.name);
          const isSelfReplying = handler?.selfReplying === true;
          const result = await opts.tools.execute(call, {
            chatId: msg.chatId,
            conversationId,
            log: cl.child({ tool: call.name }),
            signal: abort.signal,
            userMessage: msg.text,
          });
          afterTurnToolCalls.push({
            name: call.name,
            arguments: call.arguments,
            ok: result.ok,
            resultSummary: summarizeToolResult(result.output),
          });
          // Truncate before persisting / re-injecting. Self-replying tools
          // ship the FULL output to the user (we capture that below before
          // truncating), so the user never sees the truncation marker for
          // the action-confirmation case — only the next-round LLM context
          // gets the trimmed version.
          if (isSelfReplying && result.ok) {
            selfReplyingOutputs.push(result.output);
          } else {
            allSelfReplying = false;
          }
          const persisted = truncateToolResult(result.output, toolResultMaxChars);
          if (persisted.length < result.output.length) {
            cl.debug('tool result truncated for re-injection', {
              tool: call.name,
              original: result.output.length,
              kept: persisted.length,
            });
          }
          trackingAppend('tool', persisted, {
            tool_call_id: call.id,
            tool_name: call.name,
          });
        }
        // Flush the assistant-tool-call row and every tool-result row of this
        // round in one transaction. A crash before this point loses the round
        // entirely (safe — no orphans); a crash after has the whole round
        // durable.
        flushRound();
        if (allSelfReplying) {
          cl.debug('tool result short-circuit — skipping LLM follow-up', {
            outputs: selfReplyingOutputs.length,
          });
          const text = selfReplyingOutputs.join('\n');
          assistantText = text;
          await msg.send({ delta: text, done: false });
          // Synthesize a "done with no tool calls" chunk so the outer while
          // loop exits cleanly; the post-loop block then persists the
          // assistant turn once with the carried-over completion tokens. (We
          // intentionally do NOT persist here — earlier versions did, which
          // double-wrote the row and re-fed it to the model on the next turn.)
          lastChunk = {
            delta: '',
            done: true,
            ...(lastChunk.model ? { model: lastChunk.model } : {}),
            ...(lastChunk.promptTokens !== undefined
              ? { promptTokens: lastChunk.promptTokens }
              : {}),
            ...(lastChunk.completionTokens !== undefined
              ? { completionTokens: lastChunk.completionTokens }
              : {}),
          };
          break;
        }
        assistantText = '';
        // Follow-up paraphrase round. The model has the tool result; its only
        // job now is to summarize it in one or two sentences. Two changes
        // from the initial round:
        //   - Drop the tools schema. The model occasionally chains another
        //     tool call here, but the common case is "say the result back to
        //     the user". Stripping tools also stops the small model from
        //     emitting bracketed `[tool_name]` text as a fake call.
        //   - Cap completion tokens. A weather summary is ~30 tokens; without
        //     a cap qwen3.5:2b will ramble to several hundred on CPU.
        // We keep the tools PROFILE here (not the chat profile) because the
        // smaller chat model was producing garbled paraphrases of long tool
        // results (e.g. "🔑 Tool Ready" instead of the weather summary).
        const FOLLOWUP_MAX_TOKENS = 256;
        const followup = opts.llm.chat({
          profile: profileForTurn,
          messages: buildPromptForTurn(true).messages,
          maxTokens: FOLLOWUP_MAX_TOKENS,
          ...thinkOpt,
          signal: abort.signal,
          context: { chatId: msg.chatId, conversationId },
        });
        lastChunk = await drain(followup);
      }

      // Safety net: if we got no visible text after the tool loop, retry once
      // with tools off so the model has to answer in plain language. Two cases
      // land here and both otherwise surface as silent "(no reply)":
      //   (a) the model burned all its rounds tool-calling and never produced
      //       text — the original trigger for this branch
      //   (b) the model returned an empty done chunk with no text and no tool
      //       calls — small models occasionally do this when the prompt fragment
      //       describes tools that aren't in the manifest this turn
      // Dropping the tool-prompt fragment along with the schemas means the
      // model isn't told about tools that aren't on the wire this round.
      if (!assistantText && !abort.signal.aborted) {
        cl.debug('empty assistant text after tool loop — retrying with tools off', {
          round,
          hadToolCalls: !!lastChunk?.toolCalls?.length,
          escalateTo: escalationProfile,
        });
        lastChunk = await drain(retryWithToolsOff());
      }
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        cl.info('reply cancelled by /stop');
        await msg.send({ delta: '', done: true });
        return;
      }
      // The model returned an empty stream — same root condition as the
      // empty-text safety net below. Recover by retrying once with tools
      // disabled so the model is forced to produce plain language. Without
      // this branch the user sees "Sorry — I hit an error: model returned an
      // empty response" on a read-only query that just needed a tool call.
      const malformedToolCall = isMalformedToolCallError(e);
      if (
        (e instanceof LLMEmptyResponseError || malformedToolCall) &&
        !assistantText &&
        !abort.signal.aborted
      ) {
        cl.debug(
          malformedToolCall
            ? 'Ollama rejected malformed tool call — retrying with tools off'
            : 'empty LLM response — retrying with tools off',
          { error: e instanceof Error ? e.message : String(e) },
        );
        try {
          lastChunk = await drain(retryWithToolsOff());
        } catch (e2) {
          const m = e2 instanceof Error ? e2.message : String(e2);
          lastErrors.set(msg.chatId, m);
          cl.warn('llm chat failed on empty-response retry', { error: m });
          await msg.send({
            delta: assistantText ? '' : `Sorry — I hit an error: ${m}`,
            done: true,
          });
          return;
        }
      } else {
        const m = e instanceof Error ? e.message : String(e);
        lastErrors.set(msg.chatId, m);
        cl.warn('llm chat failed', { error: m });
        await msg.send({
          delta: assistantText ? '' : `Sorry — I hit an error: ${m}`,
          done: true,
        });
        return;
      }
    } finally {
      slot.abort = null;
    }

    // Post-turn reply guards. Extensions register these (host.guards.register)
    // to catch domain-specific hallucinations — e.g. the model replying "I
    // removed it" without ever calling a destructive tool, or fabricating a
    // forecast instead of calling weather_get. A guard's replacement REPLACES
    // whatever streamed (the Telegram adapter only renders on done) and gets
    // persisted so the next turn's context doesn't carry the lie forward. First
    // guard to claim the reply wins; the rest are skipped.
    let replacement: string | undefined;
    if (assistantText) {
      for (const guard of opts.turnGuards?.() ?? []) {
        let replaced: string | null = null;
        try {
          replaced = guard({ userText: msg.text, assistantText, toolCalls: afterTurnToolCalls });
        } catch (e) {
          cl.warn('turn guard threw; ignoring', {
            error: e instanceof Error ? e.message : String(e),
          });
          continue;
        }
        if (replaced !== null) {
          cl.warn('turn guard overrode reply', {
            userSample: msg.text.slice(0, 120),
            assistantSample: assistantText.slice(0, 200),
            ranTools: afterTurnToolCalls.map((c) => c.name),
          });
          replacement = replaced;
          assistantText = replaced;
          break;
        }
      }
    }
    if (assistantText) {
      trackingAppend('assistant', assistantText, {
        ...(lastChunk?.completionTokens !== undefined
          ? { tokens: lastChunk.completionTokens }
          : {}),
        ...(lastChunk?.toolCalls && lastChunk.toolCalls.length > 0
          ? { tool_calls: lastChunk.toolCalls }
          : {}),
      });
    }
    flushRound();

    const meta: ReplyChunk['meta'] = {
      model: lastChunk?.model ?? opts.llm.resolveModel(defaultProfile),
      ...(lastChunk?.promptTokens !== undefined ? { promptTokens: lastChunk.promptTokens } : {}),
      ...(lastChunk?.completionTokens !== undefined
        ? { completionTokens: lastChunk.completionTokens }
        : {}),
      elapsedMs: Date.now() - startedAt,
      afterTurn: {
        chatId: msg.chatId,
        userId: msg.userId,
        conversationId,
        userText: msg.text,
        assistantText,
        startedAt,
        finishedAt: Date.now(),
        toolCalls: afterTurnToolCalls,
      },
    };
    await msg.send({
      delta: '',
      done: true,
      meta,
      ...(replacement !== undefined ? { replace: replacement } : {}),
    });
  }

  async function pump(chatId: number): Promise<void> {
    const slot = slots.get(chatId);
    if (!slot || slot.inFlight) return;
    slot.inFlight = true;
    try {
      while (slot.queue.length > 0 && !shuttingDown) {
        const next = slot.queue.shift()!;
        try {
          await process(next, slot);
          next.resolve();
        } catch (e) {
          const m = e instanceof Error ? e.message : String(e);
          lastErrors.set(chatId, m);
          log.error('orchestrator pump error', { chatId, error: m });
          next.reject(e);
        }
      }
      if (shuttingDown) {
        while (slot.queue.length > 0) {
          const next = slot.queue.shift()!;
          void next.send({ delta: 'Shutting down — try again later.', done: true });
          next.resolve();
        }
      }
    } finally {
      slot.inFlight = false;
    }
  }

  // Per-chat queue depth ceiling. A user spamming the bot can otherwise back
  // up arbitrarily many turns behind a slow tool call. 5 is loose enough that
  // legitimate "hold on, also do X" follow-ups still queue, but tight enough
  // that a burst doesn't pin memory or stretch reply latency past anything
  // useful.
  const MAX_QUEUE_PER_CHAT = 5;

  async function handleUserMessage(msg: UserMessage): Promise<void> {
    if (shuttingDown) {
      await msg.send({ delta: 'Shutting down — try again later.', done: true });
      return;
    }
    const slot = getSlot(msg.chatId);
    if (slot.queue.length >= MAX_QUEUE_PER_CHAT) {
      log.warn('chat queue at cap, dropping message', {
        chatId: msg.chatId,
        depth: slot.queue.length,
      });
      await msg.send({
        delta: "I'm still catching up — try again once I've replied.",
        done: true,
      });
      return;
    }
    const done = new Promise<void>((resolve, reject) => {
      slot.queue.push({ ...msg, resolve, reject });
    });
    void pump(msg.chatId);
    await done;
  }

  function stop(chatId: number): boolean {
    const slot = slots.get(chatId);
    if (!slot) return false;
    // Drain pending queue first.
    const pending = slot.queue.splice(0);
    for (const queued of pending) queued.resolve();
    if (slot.abort) {
      slot.abort.abort();
      return true;
    }
    return pending.length > 0;
  }

  function newChat(chatId: number): void {
    const row = opts.db
      .prepare(`SELECT current_conversation_id AS id FROM telegram_chats WHERE chat_id = ?`)
      .get(chatId) as { id: number | null } | undefined;
    if (row?.id) {
      opts.db.prepare(`UPDATE conversations SET ended_at = ? WHERE id = ?`).run(Date.now(), row.id);
    }
    opts.db
      .prepare(
        `UPDATE telegram_chats SET current_conversation_id = NULL, last_seen_at = ? WHERE chat_id = ?`,
      )
      .run(Date.now(), chatId);
    lastErrors.delete(chatId);
  }

  function lastError(chatId: number): string | undefined {
    return lastErrors.get(chatId);
  }

  async function shutdown(): Promise<void> {
    shuttingDown = true;
    // Wait for in-flight chats to drain. Pending entries are released below:
    // once shutdown starts, pump() will not pick up another queued turn.
    const waits: Promise<void>[] = [];
    for (const [chatId, s] of slots.entries()) {
      const pending = s.queue.splice(0);
      for (const queued of pending) queued.resolve();
      if (s.inFlight) {
        waits.push(
          new Promise((resolve) => {
            const t = setInterval(() => {
              if (!s.inFlight) {
                clearInterval(t);
                resolve();
              }
            }, 25);
            t.unref?.();
            // safety: never wait more than 5s
            setTimeout(() => {
              clearInterval(t);
              resolve();
            }, 5000).unref?.();
          }),
        );
      }
      // Cancel any abortable in-flight call so shutdown isn't blocked on the
      // model.
      s.abort?.abort();
      log.debug('shutdown: cancelling chat', { chatId });
    }
    await Promise.all(waits);
  }

  return {
    handleUserMessage,
    stop,
    newChat,
    lastError,
    shutdown,
  };
}
