// Background memory extraction — after a normal chat turn, quietly pull 0–2
// durable facts about the user and persist them with memory.remember(), so later
// turns recall them through the existing prompt memory slot. The user's reply
// never waits on this: chat-dispatch invokes the returned handler in the same
// detached, fire-and-forget block as the module afterTurn chain (reply already
// shipped). Contract: docs/memory-extraction.md.
//
// Shape mirrors agent-router.ts — decide cheaply from text first, reach for the
// tiny model only when there's something to extract, collect a bounded
// non-streaming completion, parse tolerantly, and never throw into the caller.

import type { LLM } from './llm.js';
import type { Logger } from '../util/log.js';
import type { MemoryStore } from './memory.js';
import type { AfterTurnContext } from './modules.js';

export interface MemoryExtractorOptions {
  llm: LLM;
  memory: MemoryStore;
  log: Logger;
  // Gate: off for Small-tier hardware where the extra small-model call per turn
  // is the dominant cost. Resolved in start.ts from config + tier.
  enabled: boolean;
}

// A fact must be worth a model call. Below this the turn is chit-chat / an ack
// ("ok", "thanks", "yes do that") that carries no durable user truth.
const MIN_WORDS = 4;
// Hard cap on a stored fact — facts are one sentence, not paragraphs.
const MAX_FACT_CHARS = 200;
// Bounded output: a handful of short facts, no rambling.
const MAX_OUTPUT_TOKENS = 128;

const SYSTEM_PROMPT =
  'Extract 0 to 2 durable facts about the USER from their message — things still ' +
  'true next week (preferences, relationships, recurring context). No transient ' +
  'state, no chit-chat, no facts about the assistant. Reply with ONLY a JSON array ' +
  'of short declarative strings; reply [] if nothing durable.';

// Pull a JSON array of strings out of the model reply. Tolerates a bare array or
// a ```json fenced block; anything else (including the model narrating) yields [].
function parseFacts(reply: string): string[] {
  const start = reply.indexOf('[');
  const end = reply.lastIndexOf(']');
  if (start === -1 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((f): f is string => typeof f === 'string')
    .map((f) => f.trim().slice(0, MAX_FACT_CHARS))
    .filter((f) => f.length > 0);
}

async function complete(llm: LLM, userText: string): Promise<string> {
  let out = '';
  for await (const chunk of llm.chat({
    profile: 'chat',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `User: ${userText}` },
    ],
    maxTokens: MAX_OUTPUT_TOKENS,
    thinkMode: 'off',
  })) {
    out += chunk.delta ?? '';
  }
  return out;
}

// Build the afterTurn handler. Returns a function safe to call detached: it
// swallows every error to a warning and writes facts to the global hive store
// (extraction is user truth, not agent-private).
export function createMemoryExtractor(
  opts: MemoryExtractorOptions,
): (turn: AfterTurnContext) => Promise<void> {
  const { llm, memory, log, enabled } = opts;
  return async (turn: AfterTurnContext): Promise<void> => {
    if (!enabled) return;
    const text = turn.userText.trim();
    // Slash-commands and too-short turns carry nothing durable — skip before the
    // model call so the gate is also a cost gate.
    if (!text || text.startsWith('/')) return;
    if (text.split(/\s+/).length < MIN_WORDS) return;
    try {
      const facts = parseFacts(await complete(llm, text));
      for (const content of facts) {
        // remember() dedups by content hash; importance 1 lets repeated mention
        // and recall usage raise an item's standing over time, not first sight.
        memory.remember({ content, source: 'extraction', importance: 1 });
      }
      if (facts.length > 0) log.debug('memory extracted', { n: facts.length });
    } catch (e) {
      log.warn('memory extraction failed', { error: e instanceof Error ? e.message : String(e) });
    }
  };
}
