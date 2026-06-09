// Tier-aware LLM profile + context-budget tuning. Pure function on the
// configured hardware tier + the user's model selection, separated from
// start.ts so it's trivially testable.
//
// Historically the profile knobs (num_ctx, num_predict, keep_alive) and the
// orchestrator's prompt budget were hardcoded to Pi-class values regardless of
// tier — so a 32 GB / 5800H box quietly ran the same 4096-token context as a
// 4 GB Pi 4, truncating history that the RAM could easily have held. The docs
// promised "defaults scale to the hardware"; this is where that promise is
// actually kept.
//
// Scaling rationale:
//   - num_ctx (contextTokens) is the dominant lever for answer quality: a
//     bigger window keeps more conversation history before truncation. Its
//     cost is KV-cache RAM, which scales with window × model layers — cheap
//     for the small chat model, the main reason the heavy tier can be generous.
//   - budgetTokens is the prompt budget the context manager targets. It must
//     leave headroom for the completion: budget + numPredict <= contextTokens
//     of the default (chat) profile, or Ollama silently drops the tail.
//   - keep_alive is longer on bigger hosts: RAM is plentiful, so paying a
//     cold reload between turns is pure waste.
//
// Small tier keeps the previous Pi-safe profile knobs; only its prompt budget
// is corrected to leave completion headroom inside the window.

import type { ProfileConfig, ProfileName } from '../core/llm.js';

export type Tier = 'small' | 'standard' | 'heavy';

export interface ModelSelection {
  chat: string;
  reason?: string;
  tools?: string;
}

export interface TierProfiles {
  profiles: Partial<Record<ProfileName, ProfileConfig | null>>;
  // Prompt budget the orchestrator hands the context manager. Sized to the
  // chat (default) profile's window minus completion headroom.
  budgetTokens: number;
  // Default idle-eviction window for heavy models, in ms. A host with lots of
  // RAM keeps the reasoning model resident longer because the wasteful thing is
  // the cold reload, not the resident RAM; a RAM-constrained Pi evicts sooner
  // to free memory for the OS. Overridable via MODULUS_HEAVY_IDLE_MS.
  idleEvictionMs: number;
  // How many chars of a tool's output are re-fed to the model next round.
  // Bigger windows can afford richer tool output without crowding out history.
  toolResultMaxChars: number;
}

interface TierTuning {
  chat: { contextTokens: number; numPredict: number; keepAlive: string };
  reason: { contextTokens: number; numPredict: number; keepAlive: string };
  tools: { contextTokens: number; numPredict: number; keepAlive: string };
  budgetTokens: number;
  idleEvictionMs: number;
  toolResultMaxChars: number;
  // Prompt-processing batch size (`num_batch`) applied to every profile on the
  // tier. Cuts time-to-first-token on long prompts at the cost of a little RAM.
  // Omitted on small => Ollama's 512 default (a Pi has neither the RAM headroom
  // nor the long prompts to benefit).
  numBatch?: number;
}

const MIN = 60_000;

const TUNING: Record<Tier, TierTuning> = {
  // Pi 4 / Pi 5, 4–8 GB. Profile knobs are unchanged from the original
  // hardcoded values. The prompt budget is trimmed from 4096 to 3584 so it
  // leaves room for the 512-token completion inside the 4096 window —
  // previously prompt+completion could exceed num_ctx, forcing Ollama to
  // shift the window mid-turn and invalidate the cached KV prefix.
  small: {
    chat: { contextTokens: 4096, numPredict: 512, keepAlive: '30m' },
    reason: { contextTokens: 8192, numPredict: 2048, keepAlive: '10m' },
    tools: { contextTokens: 4096, numPredict: 1024, keepAlive: '10m' },
    budgetTokens: 3584,
    idleEvictionMs: 10 * MIN,
    toolResultMaxChars: 2000,
  },
  // Mini PC, ~16 GB. Roughly double the chat window; more reasoning headroom.
  standard: {
    chat: { contextTokens: 8192, numPredict: 768, keepAlive: '30m' },
    reason: { contextTokens: 16384, numPredict: 3072, keepAlive: '15m' },
    tools: { contextTokens: 8192, numPredict: 1024, keepAlive: '15m' },
    budgetTokens: 6144,
    idleEvictionMs: 20 * MIN,
    toolResultMaxChars: 4000,
    numBatch: 1024,
  },
  // 5800H+ / 32 GB. Generous windows the RAM can comfortably hold, long
  // keep-alive so back-to-back turns never pay a reload.
  heavy: {
    chat: { contextTokens: 16384, numPredict: 1024, keepAlive: '30m' },
    reason: { contextTokens: 32768, numPredict: 4096, keepAlive: '30m' },
    tools: { contextTokens: 16384, numPredict: 1536, keepAlive: '30m' },
    budgetTokens: 12288,
    idleEvictionMs: 45 * MIN,
    toolResultMaxChars: 6000,
    numBatch: 2048,
  },
};

export function profilesForTier(tier: Tier | undefined, models: ModelSelection): TierProfiles {
  // Unknown/unset tier falls back to the conservative small profile so a
  // misconfigured host never over-commits RAM.
  const t = TUNING[tier ?? 'small'];

  const batch = t.numBatch !== undefined ? { numBatch: t.numBatch } : {};

  const profiles: Partial<Record<ProfileName, ProfileConfig | null>> = {
    chat: {
      model: models.chat,
      contextTokens: t.chat.contextTokens,
      heavy: false,
      numPredict: t.chat.numPredict,
      keepAlive: t.chat.keepAlive,
      ...batch,
    },
  };

  if (models.reason) {
    profiles.reason = {
      model: models.reason,
      contextTokens: t.reason.contextTokens,
      heavy: true,
      numPredict: t.reason.numPredict,
      keepAlive: t.reason.keepAlive,
      ...batch,
    };
  }

  if (models.tools) {
    // heavy=false so the tool model doesn't fight the reasoning model for the
    // single heavy slot.
    profiles.tools = {
      model: models.tools,
      contextTokens: t.tools.contextTokens,
      heavy: false,
      numPredict: t.tools.numPredict,
      keepAlive: t.tools.keepAlive,
      ...batch,
    };
  }

  return {
    profiles,
    budgetTokens: t.budgetTokens,
    idleEvictionMs: t.idleEvictionMs,
    toolResultMaxChars: t.toolResultMaxChars,
  };
}
