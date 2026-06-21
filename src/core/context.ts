// Context manager. Builds the prompt the LLM sees so Ollama's KV slot cache
// stays warm across turns. Two regions:
//
//   STABLE PREFIX   system -> tools -> session -> history
//   VOLATILE TAIL   (turn-context + memory), as a system message injected
//                   immediately before the latest user turn.
//
// Per PLAN North Star "Deterministic prompt prefix". The win is keeping the
// reusable token prefix as LONG as possible: Ollama only reuses KV up to the
// longest common prefix with the previous turn, so any block that changes
// turn-to-turn caps reuse at its position. The clock (changes every few
// minutes) and recalled memory (different every message) are exactly such
// blocks — parked in the prefix they used to sit *before* history and force a
// full re-prefill of all history on every turn. Moving them to the tail, right
// next to the always-new user turn, lets system+tools+history stay cached.
// (Pruned tools still cap reuse when the turn's intent changes; for a focused
// multi-turn conversation — the common case — the tool block is identical, so
// history now reuses its KV.)
//
// Token counting is approximate by design: real tokenization is
// model-specific and Ollama doesn't expose its tokenizer. ~4 chars per token
// is a workable upper bound for qwen3-class models. The orchestrator tightens
// this with the real prompt_tokens count Ollama returns after each turn.

import type { ChatMessage, Role, ToolCall } from './llm.js';

export interface HistoryMessage {
  role: Role;
  content: string;
  tool_call_id?: string;
  tool_name?: string;
  tool_calls?: ToolCall[];
}

export interface BuildOptions {
  systemPrompt: string;
  // Natural-language tool fragment (e.g. a module's prompt.md). The
  // OpenAI-shaped tool schemas go into ChatOptions.tools, not here.
  toolPrompt?: string;
  // Per-turn volatile context — the date/time anchor and anything else that
  // changes every turn. Rendered at the TAIL (its own system message right
  // before the latest user turn), never in the stable prefix, so it can't
  // invalidate the cached system+tools+history KV. See the file header.
  turnContext?: string;
  // Long-term memory results retrieved for this turn (populated by whichever
  // module is providing memory; e.g. the hive store). Volatile — keyed to the
  // message — so it rides the tail next to turnContext, not the prefix.
  memory?: string;
  // Compact running session summary kept between turns. Stable across a turn's
  // tool rounds, so it stays in the prefix.
  session?: string;
  history: HistoryMessage[];
  // Approx max tokens the assembled prompt may consume. Older history is
  // dropped first to fit; the newest user turn is always preserved.
  budgetTokens: number;
}

export interface BuiltPrompt {
  messages: ChatMessage[];
  approxTokens: number;
  truncated: boolean;
}

export function approxTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export function build(opts: BuildOptions): BuiltPrompt {
  const prefixParts: string[] = [];
  if (opts.systemPrompt) prefixParts.push(opts.systemPrompt);
  if (opts.toolPrompt) prefixParts.push(opts.toolPrompt);
  if (opts.session) prefixParts.push(opts.session);

  // Volatile per-turn block, rendered at the tail (see header). Order within
  // it doesn't affect cache reuse — the whole block sits past the cached
  // prefix — so it's just clock then memory.
  const tailParts: string[] = [];
  if (opts.turnContext) tailParts.push(opts.turnContext);
  if (opts.memory) tailParts.push(opts.memory);
  const tailText = tailParts.join('\n\n');

  const SAFETY = 64;
  const prefixText = prefixParts.join('\n\n');
  // The tail is never dropped, so it counts toward the fixed overhead the
  // history must fit under, same as the prefix did when memory lived there.
  const prefixTokens = approxTokens(prefixText) + approxTokens(tailText) + SAFETY;

  const history = [...opts.history];
  let pinnedIdx = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]!.role === 'user') {
      pinnedIdx = i;
      break;
    }
  }

  const tokensOf = (m: HistoryMessage): number => approxTokens(m.content);
  // Maintain a running total so each shift is O(1); the previous reduce-on-
  // every-iteration was O(n²) when truncating long histories.
  let historyTokens = 0;
  for (const m of history) historyTokens += tokensOf(m);

  let truncated = false;
  // Drop oldest entries until total fits, but never drop the pinned message.
  while (prefixTokens + historyTokens > opts.budgetTokens && history.length > 0) {
    // The pinned index shifts as we drop from the front.
    if (pinnedIdx === 0) break;
    const dropped = history.shift()!;
    historyTokens -= tokensOf(dropped);
    pinnedIdx -= 1;
    truncated = true;
  }

  // Truncation (or a history that simply begins mid tool-exchange) can leave a
  // leading `tool` result whose preceding assistant tool-call turn was dropped.
  // Strict chat backends reject a tool message with no matching tool_calls
  // before it, so peel any orphaned leading tool results off the front. Never
  // cross the pinned user turn — that's always kept.
  while (history.length > 0 && history[0]!.role === 'tool' && pinnedIdx > 0) {
    const dropped = history.shift()!;
    historyTokens -= tokensOf(dropped);
    pinnedIdx -= 1;
    truncated = true;
  }

  // Symmetric to the leading peel: a crash between persisting an assistant
  // tool-call turn and its tool results (the very gap flushRound's transaction
  // defends against) can leave a trailing assistant `tool_calls` message with
  // no following results. Strict backends reject that turn just as they reject a
  // leading orphan, so peel any trailing orphaned tool-call turns off the end.
  // Only past the pinned user turn — that's always kept, and a real tool round
  // carries its results after the assistant, so a non-last tool-call turn isn't
  // an orphan.
  while (
    history.length - 1 > pinnedIdx &&
    history[history.length - 1]!.role === 'assistant' &&
    (history[history.length - 1]!.tool_calls?.length ?? 0) > 0
  ) {
    const dropped = history.pop()!;
    historyTokens -= tokensOf(dropped);
    truncated = true;
  }

  const messages: ChatMessage[] = [];
  if (prefixText) messages.push({ role: 'system', content: prefixText });
  for (let i = 0; i < history.length; i++) {
    // Inject the volatile tail as its own system message immediately before the
    // latest user turn, so everything ahead of it (the prefix + all prior
    // history) is a stable, cacheable token prefix.
    if (tailText && i === pinnedIdx) messages.push({ role: 'system', content: tailText });
    const h = history[i]!;
    const m: ChatMessage = { role: h.role, content: h.content };
    if (h.tool_call_id) m.tool_call_id = h.tool_call_id;
    if (h.tool_name) m.tool_name = h.tool_name;
    if (h.tool_calls) m.tool_calls = h.tool_calls;
    messages.push(m);
  }
  // No user turn to anchor to (empty history, or history with no user role):
  // fall back to appending the tail at the end so its context isn't lost.
  if (tailText && pinnedIdx < 0) messages.push({ role: 'system', content: tailText });

  return {
    messages,
    approxTokens: prefixTokens + historyTokens,
    truncated,
  };
}
