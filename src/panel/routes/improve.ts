// Shared "Improve my prompt" endpoint. Every prompt field in the panel — the
// Dashboard chat composer, an agent's system prompt, a dispatched/launched task,
// a routine instruction — posts its current draft here and gets back a cleaner
// rewrite from the tiny model. One non-streaming round-trip, no history: a pure
// rewrite that keeps the user's intent and language and only sharpens wording.
// The model is told to emit ONLY the rewritten text; clean() strips the wrappers
// small models add anyway (fences, surrounding quotes).

import type { ChatMessage } from '../../core/llm.js';
import { readJson, sendJson } from '../http.js';
import type { RouteModule } from '../router.js';
import type { PanelDeps } from '../types.js';

// A draft worth rewriting is a sentence or a paragraph, not a document. Cap so a
// paste-bomb can't drive a giant generation; the UI also disables the button
// below a couple of characters.
const MAX_INPUT_CHARS = 4000;
const MAX_OUTPUT_TOKENS = 700;

// Per-field guidance keyed by the `kind` the form sends. An unknown kind falls
// back to GENERIC so a new caller never 400s on a missing case.
const KIND_GUIDANCE: Record<string, string> = {
  chat:
    'The text is a message the user is sending to an AI assistant. Make the request clear and ' +
    'specific so the assistant can act on it in one go.',
  'agent-system':
    "The text is an AI agent's instructions (its system prompt). Make it a clear, well-structured " +
    "description of the agent's role, how it should behave, and any limits — directive and concise.",
  'agent-task':
    'The text is a task handed to an AI agent to carry out on its own. Make it an actionable brief ' +
    'with a clear goal and any concrete success criteria.',
  routine:
    'The text is the instruction for an automation that runs on a schedule or trigger. Make it ' +
    'precise and self-contained so it runs the same way every time with nobody watching.',
};
const GENERIC_GUIDANCE = 'Make the text clearer, more specific, and better organized.';

export function buildImproveMessages(text: string, kind: string): ChatMessage[] {
  const guidance = KIND_GUIDANCE[kind] ?? GENERIC_GUIDANCE;
  return [
    {
      role: 'system',
      content:
        'You improve a draft prompt. Rewrite it to be clearer and more effective WITHOUT changing ' +
        'its intent, and keep the original language. ' +
        guidance +
        ' Do not answer or carry out the request — only rewrite it. Reply with ONLY the rewritten ' +
        'text: no preamble, no quotes, no commentary, no markdown fences.',
    },
    { role: 'user', content: text },
  ];
}

// Small models often wrap the rewrite in a code fence or quotes despite the
// instruction. Peel a single surrounding fence and matching outer quotes.
export function clean(reply: string): string {
  let s = reply.trim();
  const fence = s.match(/^```[a-z]*\n([\s\S]*?)\n?```$/i);
  if (fence) s = fence[1]!.trim();
  const first = s[0];
  const last = s[s.length - 1];
  if (
    s.length >= 2 &&
    ((first === '"' && last === '"') || (first === '“' && last === '”'))
  ) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

export function createImproveRoutes(deps: PanelDeps): RouteModule {
  return async ({ req, res, path, method }) => {
    if (path !== '/api/improve-prompt' || method !== 'POST') return false;

    const body = await readJson<{ text?: string; kind?: string }>(req);
    const text = (body.text ?? '').trim();
    if (!text) {
      sendJson(res, 400, { error: 'nothing to improve' });
      return true;
    }
    if (text.length > MAX_INPUT_CHARS) {
      sendJson(res, 400, { error: 'that text is too long to improve' });
      return true;
    }
    const kind = typeof body.kind === 'string' ? body.kind : '';

    try {
      let out = '';
      for await (const chunk of deps.llm.chat({
        profile: 'chat',
        messages: buildImproveMessages(text, kind),
        maxTokens: MAX_OUTPUT_TOKENS,
        thinkMode: 'off',
      })) {
        out += chunk.delta ?? '';
      }
      const improved = clean(out);
      if (!improved) {
        sendJson(res, 502, { error: 'could not improve the prompt — try again' });
        return true;
      }
      sendJson(res, 200, { text: improved });
    } catch (e) {
      deps.log.warn('improve-prompt failed', {
        error: e instanceof Error ? e.message : String(e),
      });
      sendJson(res, 502, { error: 'could not improve the prompt — try again' });
    }
    return true;
  };
}
