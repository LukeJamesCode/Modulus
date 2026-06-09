// Model-family capability heuristic. This is the *fallback* used when Ollama's
// /api/show capability probe is unavailable (older Ollama that doesn't report
// capabilities, the model isn't pulled, or the probe call fails) — see
// resolveThinking() in llm.ts, which prefers the authoritative probe and only
// drops to this tag-based guess when it can't get one.
//
// Keyed off the Ollama tag prefix so it covers every size of a family.
// Versioned where it matters: Gemma 2/3 have no thinking mode, but Gemma 4+ are
// configurable reasoners (and Ollama accepts the `think` parameter for them),
// so they must be treated like qwen3 — suppressed on small devices rather than
// left to burn CPU on hidden <think> blocks.

export type ModelFamily = 'qwen3' | 'gemma' | 'other';

// Tri-state on purpose. 'unknown' is distinct from 'no': an unknown model under
// an explicit thinkMode:'off' should still be suppressed (the user opted in
// knowing their model), whereas a model we *know* can't think (Gemma 2/3) must
// never be sent think:false even under 'off', because Ollama errors the turn.
export type ThinkingSupport = 'yes' | 'no' | 'unknown';

export interface ModelCapabilities {
  family: ModelFamily;
  thinking: ThinkingSupport;
  // Whether the family accepts image inputs (Ollama `messages[].images`). Same
  // tri-state as `thinking`. FALLBACK ONLY — llm.ts prefers Ollama's
  // authoritative /api/show `capabilities: ['vision', …]` probe and drops here
  // only when the probe can't answer.
  vision: ThinkingSupport;
}

export function modelFamily(tag: string): ModelCapabilities {
  if (/(?:^|\/)gemma/i.test(tag)) {
    const match = /(?:^|\/)gemma(?:[-_]?(\d+))?/i.exec(tag);
    const ver = Number(match?.[1] ?? 0);
    // Gemma 4+ are reasoners with a configurable thinking mode; 2/3 are not.
    // Vision is a fallback guess only — the /api/show probe is authoritative
    // (and catches multimodal gemma3 variants); the tag heuristic stays
    // conservative at 4+ to match the qwen3.5/gemma4 default the user runs.
    return { family: 'gemma', thinking: ver >= 4 ? 'yes' : 'no', vision: ver >= 4 ? 'yes' : 'no' };
  }
  if (/qwen3/i.test(tag)) return { family: 'qwen3', thinking: 'yes', vision: 'yes' };
  return { family: 'other', thinking: 'unknown', vision: 'unknown' };
}
