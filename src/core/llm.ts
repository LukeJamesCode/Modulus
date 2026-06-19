// LLM interface. Pluggable by design; only Ollama HTTP is wired in Phase 1.
//
// Responsibilities:
// - Profile routing: callers ask for "chat" | "reason" | "tools" | a literal
//   model name, the interface picks the right backing model. The "tools"
//   profile is what the orchestrator uses for any chat call that has tool
//   schemas attached — splitting it out lets the user point a tool-fluent
//   model (often a different size or family from chat) at every tool turn.
// - Eviction: only one heavy model resident at a time (PLAN North Star /
//   "Heavy-model eviction"). When a profile other than the resident heavy one
//   is asked for, we ask Ollama to unload the previous one (keep_alive=0).
//   On top of that an optional idle sweep proactively unloads heavy models
//   that haven't been used for `idleEvictionMs` so a one-shot reasoning turn
//   doesn't pin RAM forever on a Pi-class host.
// - Circuit breaker: trips after N consecutive failures, opens for a cooldown,
//   then half-opens. While open we fail fast with a typed error. The half-
//   open phase requires `halfOpenGrace` consecutive successes before the
//   breaker fully closes — single-probe re-opens were chattering against a
//   real-world transient blip (Ollama's first cold-load on a Pi).
// - Streaming: chat() yields a stream of deltas the orchestrator forwards
//   to Telegram in chunks.

import type { Logger } from '../util/log.js';
import { composeAbort } from '../util/abort.js';
import { modelFamily } from './model-family.js';

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: Role;
  content: string;
  tool_call_id?: string;
  tool_name?: string;
  tool_calls?: ToolCall[];
  // Base64-encoded images (no `data:` prefix) for a multimodal model. Forwarded
  // verbatim as Ollama's `messages[].images`. Ignored by text-only models, so
  // callers must gate on LLM.supportsVision before attaching them.
  images?: string[];
}

export interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type ProfileName = 'chat' | 'reason' | 'tools';

// Whether to let a thinking-capable model emit its reasoning blocks.
//   'auto' — per-model default (suppress on models known to think).
//   'on'   — never suppress; let the model think.
//   'off'  — suppress where the model supports it.
// Settable per-profile (ProfileConfig) or overridden per-turn (ChatOptions),
// e.g. by the panel's think toggle. No-op on models with no thinking mode.
export type ThinkMode = 'auto' | 'on' | 'off';

export interface ProfileConfig {
  // Ollama model tag, e.g. "qwen3.5:0.8b".
  model: string;
  // Approx max prompt tokens (`num_ctx` and the budget the context manager
  // targets).
  contextTokens: number;
  // If true, this profile occupies the heavy slot — only one heavy profile is
  // resident at a time.
  heavy: boolean;
  // keep_alive forwarded to Ollama. "0" unloads immediately; default "5m".
  keepAlive?: string;
  // Cap on completion tokens (`num_predict`). Without this Ollama lets the
  // model ramble up to the context window — a single tool-flow turn was
  // observed generating 694 completion tokens for what should have been a
  // ~25-token confirmation, costing ~80s on CPU. Per-profile because the
  // reasoning model genuinely needs more headroom than the tool model does.
  numPredict?: number;
  // Prompt-processing batch size (`num_batch`). Larger batches keep the CPU
  // better fed while ingesting the prompt, cutting time-to-first-token on long
  // prompts — which matter more once the context window is widened. Costs a
  // little RAM per batch (trivial on a 16/32 GB host). Omitted => Ollama's
  // default (512). Per-profile because only the bigger tiers raise it.
  numBatch?: number;
  // Controls the /no_think hint we inject for thinking-capable model families.
  //   'auto' (default) — disable thinking when the family is known to think (qwen3).
  //   'on'             — never inject /no_think; let the model think.
  //   'off'            — inject /no_think where the model supports it.
  // Reasoning profiles on bigger hosts may want 'on'; tool-call profiles want 'off'.
  // No-op for families known not to support thinking (e.g. Gemma 2/3): sending
  // Ollama's `think` parameter to them errors the turn, so suppression is
  // never applied there regardless of this setting. See model-family.ts.
  // A per-turn ChatOptions.thinkMode overrides this.
  thinkMode?: ThinkMode;
}

export interface ChatOptions {
  profile: ProfileName | { model: string };
  messages: ChatMessage[];
  tools?: ToolSchema[];
  // Per-turn override of the profile's thinkMode. Takes precedence over
  // ProfileConfig.thinkMode; falls back to it (then 'auto') when unset. Used by
  // the panel's per-turn think toggle and per-agent think setting.
  thinkMode?: ThinkMode;
  // AbortSignal forwarded to fetch so /stop can cancel a streaming reply.
  signal?: AbortSignal;
  // Per-call timeout override in ms. Defaults to the instance inferenceTimeoutMs
  // (120s). Pass a higher value for long-running generation (e.g. Tudor lessons).
  timeoutMs?: number;
  // Stop the model after this many tokens. Soft cap; Ollama also enforces.
  maxTokens?: number;
  // Optional caller context for non-Ollama providers that need to meter or
  // attribute a turn. Ollama ignores this.
  context?: {
    chatId?: number;
    conversationId?: number;
  };
}

export interface ChatChunk {
  // Delta of assistant text since the previous chunk, or '' when the chunk
  // contains only tool calls / metadata.
  delta: string;
  // Delta of the model's reasoning since the previous chunk, for thinking-
  // capable models run with reasoning enabled. Ollama streams reasoning in a
  // separate `message.thinking` field, NOT in content — kept separate here so
  // the orchestrator can surface it as its own channel and never fold it into
  // the visible answer. Empty/absent on non-thinking turns.
  thinking?: string;
  // Final chunk with usage / model info. Tool calls and the resolved model
  // name only appear here.
  done: boolean;
  model?: string;
  toolCalls?: ToolCall[];
  promptTokens?: number;
  completionTokens?: number;
}

export type BreakerStatePublic = 'closed' | 'open' | 'half-open';

export interface BreakerSnapshot {
  state: BreakerStatePublic;
  failures: number;
  consecutiveSuccesses: number;
  openedAt: number | null;
  // When the breaker is open, when callers can next try.
  retryAt: number | null;
}

export interface LLMProviderChatOptions extends ChatOptions {
  // The fully resolved configured model reference, e.g. "codex" or
  // "codex:gpt-5-codex".
  model: string;
}

export interface LLMProvider {
  id: string;
  models?: () => string[];
  health?: () => Promise<{ ok: boolean; models: string[] }>;
  chat(opts: LLMProviderChatOptions): AsyncIterable<ChatChunk>;
}

export interface LLM {
  chat(opts: ChatOptions): AsyncIterable<ChatChunk>;
  health(): Promise<{
    ok: boolean;
    models: string[];
    providers?: Record<string, { ok: boolean; models: string[] }>;
  }>;
  listProfiles(): Record<ProfileName, ProfileConfig | null>;
  resolveModel(profile: ProfileName | { model: string }): string;
  // Whether a model accepts image inputs (Ollama vision capability). Optional so
  // existing fakes/providers need no change; callers must default a missing
  // implementation to false (fail closed — never attach images blindly).
  supportsVision?(model: string): Promise<boolean>;
  // Diagnostic surface for `modulus status` / health JSON. Returns a snapshot
  // of the breaker so the CLI can render the current resilience state.
  breakerSnapshot(): BreakerSnapshot;
  // Stop the idle-eviction timer. Test/teardown hook.
  stopIdleEviction(): void;
  // Immediately unload the resident heavy model (Ollama keep_alive=0) if one is
  // loaded and no heavy inference is in flight. Lets the agent queue free the
  // big model the moment its work drains, instead of waiting out keep_alive or
  // the 10-minute idle sweep — the whole
  // point on a RAM-constrained Pi. Optional so fakes/providers need no change;
  // a no-op when nothing heavy is resident.
  releaseHeavy?(): Promise<void>;
  // Optional module hook. Routed LLMs expose this so an enabled module can
  // contribute a model alias without core importing module code.
  registerProvider?: (provider: LLMProvider) => () => void;
  // Re-point already-configured profiles at different Ollama tags without a
  // restart, so a Settings model change takes effect on the very next turn
  // instead of waiting for the next boot. Only the `model` of an existing
  // profile is swapped — context/keep_alive/num_predict (which the orchestrator
  // budget is matched to) are untouched, and a slot the host didn't configure
  // at boot is left absent (adding/removing a slot still needs a restart).
  // Optional so fakes/providers need no change.
  updateModels?(models: { chat?: string; reason?: string; tools?: string }): void;
}

export class CircuitOpenError extends Error {
  constructor(public retryAt: number) {
    super('llm circuit breaker open');
    this.name = 'CircuitOpenError';
  }
}

export class LLMHttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'LLMHttpError';
  }
}

// Thrown when Ollama returns an empty stream (no content + no tool calls).
// Distinct from a transport error: the call succeeded, the model just
// produced nothing useful. Surfacing this lets the orchestrator turn it
// into an explicit error message instead of streaming silence.
export class LLMEmptyResponseError extends Error {
  constructor() {
    super('model returned an empty response');
    this.name = 'LLMEmptyResponseError';
  }
}

// Thrown when our own inference cap fires (not a caller /stop). A slow model on
// CPU — e.g. a 12B doing a research round — can legitimately exceed the cap;
// surfacing this distinctly lets the orchestrator fail loud with a real error
// instead of mistaking the abort for a user cancellation and saving an empty
// reply. Kept out of the circuit breaker: a timeout is a latency problem, not a
// dead backend, and tripping the breaker would lock the bot out of its LLM.
export class LLMTimeoutError extends Error {
  constructor(public timeoutMs: number) {
    super(`inference timed out after ${timeoutMs}ms`);
    this.name = 'LLMTimeoutError';
  }
}

interface BreakerState {
  failures: number;
  // Successes counted while the breaker is half-open. Required to be
  // >= halfOpenGrace before the breaker fully closes — a single flaky
  // probe success used to declare the backend healthy and re-open on the
  // next blip, which produced visible "circuit open" thrash during
  // ordinary cold-starts.
  consecutiveSuccesses: number;
  openedAt: number | null;
  // True between the cooldown ending and halfOpenGrace successes.
  halfOpen: boolean;
}

export interface OllamaOptions {
  baseUrl: string;
  profiles: Partial<Record<ProfileName, ProfileConfig | null>>;
  log: Logger;
  // For tests.
  fetchImpl?: typeof fetch;
  now?: () => number;
  // Circuit breaker: trip after N consecutive failures, cool down for ms.
  failureThreshold?: number;
  cooldownMs?: number;
  // How many consecutive successful calls during half-open are required to
  // fully close the breaker. Default 2 — atlas's `CB_HALFOPEN_GRACE`. The
  // first success alone isn't enough to call the backend healthy on a slow
  // Pi where Ollama's first cold-load can succeed and the next blip be a
  // genuine outage; demanding two in a row gives the system a smoothing
  // window without dragging on indefinitely.
  halfOpenGrace?: number;
  // Hard ceiling for a single inference. Without this a hung Ollama hangs the
  // whole user queue. Defaults to 120s — long enough for cold-start of a
  // 9b heavy model on CPU, short enough that a real outage surfaces fast.
  inferenceTimeoutMs?: number;
  // Periodic check that unloads heavy profiles which haven't been called in
  // this many ms. 0 disables the sweep. Default 10 minutes — matches atlas.
  // The check itself is cheap (just compares timestamps); the eviction call
  // is only made when something is actually idle.
  idleEvictionMs?: number;
  // How often the idle sweep wakes up. Default 60s. Test-only knob —
  // production callers leave it on the default.
  idleEvictionTickMs?: number;
}

export function createOllama(opts: OllamaOptions): LLM {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const failureThreshold = opts.failureThreshold ?? 3;
  const cooldownMs = opts.cooldownMs ?? 30_000;
  const halfOpenGrace = Math.max(1, opts.halfOpenGrace ?? 2);
  const inferenceTimeoutMs = opts.inferenceTimeoutMs ?? 120_000;
  const idleEvictionMs = opts.idleEvictionMs ?? 10 * 60_000;
  const idleEvictionTickMs = opts.idleEvictionTickMs ?? 60_000;
  const log = opts.log.child({ mod: 'llm' });

  // Live-mutable profile map. Seeded from boot config; updateModels() swaps a
  // profile's model in place so a Settings change applies without a restart.
  // Everything below reads through this binding rather than opts.profiles.
  const profiles: Partial<Record<ProfileName, ProfileConfig | null>> = { ...opts.profiles };

  const breaker: BreakerState = {
    failures: 0,
    consecutiveSuccesses: 0,
    openedAt: null,
    halfOpen: false,
  };
  // Tracks which heavy model is currently resident, so we can evict it before
  // loading a different heavy model. residentHeavyProfile is the profile name
  // that maps to it, cached so the idle sweep doesn't rescan opts.profiles
  // every tick to recover it.
  let residentHeavy: string | null = null;
  let residentHeavyProfile: string | null = null;
  // Count of heavy inferences currently streaming. releaseHeavy() refuses to
  // unload while this is > 0: that call is deliberately keeping the model hot,
  // and the caller fires releaseHeavy again once it next goes idle. Guards the
  // cross-component race where one task finishing unloads the model another
  // agent-queue task (which bypasses the queue's heavy governor) is mid-using.
  let heavyInFlight = 0;
  // Last-used timestamps per profile name. The idle sweep reads this to
  // decide whether to unload a heavy profile.
  const lastCallAt = new Map<string, number>();
  // Per-model thinking-capability cache, populated from Ollama's /api/show
  // probe. Only successful probes are cached (a failure leaves the entry unset
  // so a later turn retries once Ollama is reachable). Capabilities don't change
  // within a process, so a hit avoids re-probing on every turn.
  const thinkingCache = new Map<string, 'yes' | 'no'>();
  // Same caching contract as thinkingCache, for the vision capability.
  const visionCache = new Map<string, 'yes' | 'no'>();
  let idleTimer: ReturnType<typeof setInterval> | null = null;
  // Serializes eviction. Two concurrent chat() calls onto different heavy
  // profiles would otherwise both see `residentHeavy === X` and race the
  // unload — Ollama then has to cope with overlapping unload/load on the
  // same model, which has been observed to wedge it on Pi-class hardware.
  let evictionLock: Promise<void> = Promise.resolve();

  function resolveProfile(p: ProfileName | { model: string }): {
    model: string;
    cfg: ProfileConfig | null;
    profileName: string;
  } {
    if (typeof p === 'object') return { model: p.model, cfg: null, profileName: p.model };
    const cfg = profiles[p];
    if (!cfg) {
      throw new Error(`profile '${p}' is not configured`);
    }
    return { model: cfg.model, cfg, profileName: p };
  }

  function checkBreaker(): void {
    if (breaker.openedAt === null) return;
    if (now() - breaker.openedAt < cooldownMs) {
      throw new CircuitOpenError(breaker.openedAt + cooldownMs);
    }
    // Cooldown elapsed — enter half-open. We don't reset openedAt yet
    // because a failure during half-open should slide back into open with
    // a fresh cooldown.
    if (!breaker.halfOpen) {
      breaker.halfOpen = true;
      breaker.consecutiveSuccesses = 0;
      log.info('circuit breaker half-open', { graceProbes: halfOpenGrace });
    }
  }

  function recordFailure(err: unknown): void {
    breaker.failures += 1;
    breaker.consecutiveSuccesses = 0;
    // While half-open, any failure trips back to open with a fresh cooldown
    // window so we don't hammer a still-broken backend.
    if (breaker.halfOpen) {
      breaker.openedAt = now();
      breaker.halfOpen = false;
      log.warn('circuit breaker re-opened from half-open', {
        cause: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (breaker.failures >= failureThreshold && breaker.openedAt === null) {
      breaker.openedAt = now();
      log.warn('circuit breaker opened', {
        failures: breaker.failures,
        cooldownMs,
        cause: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function recordSuccess(): void {
    if (breaker.halfOpen) {
      breaker.consecutiveSuccesses += 1;
      if (breaker.consecutiveSuccesses >= halfOpenGrace) {
        log.info('circuit breaker closed', { successes: breaker.consecutiveSuccesses });
        breaker.failures = 0;
        breaker.openedAt = null;
        breaker.halfOpen = false;
        breaker.consecutiveSuccesses = 0;
      }
      return;
    }
    if (breaker.failures > 0 || breaker.openedAt !== null) {
      log.debug('circuit breaker reset');
    }
    breaker.failures = 0;
    breaker.openedAt = null;
    breaker.consecutiveSuccesses = 0;
  }

  function breakerSnapshot(): BreakerSnapshot {
    let state: BreakerStatePublic = 'closed';
    if (breaker.halfOpen) state = 'half-open';
    else if (breaker.openedAt !== null) state = 'open';
    return {
      state,
      failures: breaker.failures,
      consecutiveSuccesses: breaker.consecutiveSuccesses,
      openedAt: breaker.openedAt,
      retryAt: breaker.openedAt !== null ? breaker.openedAt + cooldownMs : null,
    };
  }

  async function evictIfNeeded(target: {
    model: string;
    cfg: ProfileConfig | null;
    profileName: string;
  }): Promise<void> {
    if (!target.cfg?.heavy) return;
    const run = async (): Promise<void> => {
      if (residentHeavy === null || residentHeavy === target.model) {
        residentHeavy = target.model;
        residentHeavyProfile = target.profileName;
        return;
      }
      await unloadModel(residentHeavy, 'switching heavy profiles');
      residentHeavy = target.model;
      residentHeavyProfile = target.profileName;
    };
    evictionLock = evictionLock.then(run, run);
    await evictionLock;
  }

  async function unloadModel(model: string, reason: string): Promise<void> {
    log.info('unloading heavy model', { model, reason });
    try {
      // Ollama's "unload" idiom: a generate call with keep_alive=0 and an
      // empty prompt instructs the server to drop the model from RAM.
      await fetchImpl(`${opts.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, prompt: '', keep_alive: 0, stream: false }),
      });
    } catch (e) {
      log.warn('unload call failed (continuing)', {
        model,
        cause: e instanceof Error ? e.message : String(e),
      });
    }
  }

  function ensureIdleSweep(): void {
    if (idleTimer || idleEvictionMs <= 0) return;
    idleTimer = setInterval(() => {
      void runIdleSweep().catch((e) => {
        log.warn('idle sweep failed', {
          error: e instanceof Error ? e.message : 'idle sweep error',
        });
      });
    }, idleEvictionTickMs);
    // Don't pin the event loop just for the eviction timer. unref() returns
    // the timer; older Node had it on the Timeout but we guard the call.
    idleTimer.unref?.();
  }

  async function runIdleSweep(): Promise<void> {
    if (!residentHeavy || !residentHeavyProfile) return;
    const last = lastCallAt.get(residentHeavyProfile);
    if (last === undefined) return;
    if (now() - last < idleEvictionMs) return;
    log.info('idle eviction firing', {
      model: residentHeavy,
      idleMs: now() - last,
      thresholdMs: idleEvictionMs,
    });
    const evicted = residentHeavy;
    residentHeavy = null;
    residentHeavyProfile = null;
    await unloadModel(evicted, 'idle eviction');
  }

  function stopIdleEviction(): void {
    if (idleTimer) {
      clearInterval(idleTimer);
      idleTimer = null;
    }
  }

  // Proactively unload the resident heavy model right now rather than on a
  // timer. Background executors call this the instant their work drains so a
  // one-shot reasoning agent doesn't pin 6+ GB of RAM for the whole
  // keep_alive window on a Pi-class host. Skips the unload when a heavy call is
  // still streaming (heavyInFlight > 0). Serialized through the same lock as
  // evictIfNeeded so a release and a concurrent load can't race the
  // residentHeavy bookkeeping.
  async function releaseHeavy(): Promise<void> {
    const run = async (): Promise<void> => {
      if (!residentHeavy || heavyInFlight > 0) return;
      const model = residentHeavy;
      residentHeavy = null;
      residentHeavyProfile = null;
      await unloadModel(model, 'background work drained');
    };
    evictionLock = evictionLock.then(run, run);
    await evictionLock;
  }

  // One /api/show probe shared by every capability lookup. Returns 'yes'/'no'
  // from the authoritative `capabilities` list, or null when the probe can't
  // answer (pre-capabilities Ollama, model not pulled, network/timeout). Never
  // throws and never touches the circuit breaker — a failed capability lookup
  // must not look like an inference outage.
  async function probeCapability(model: string, capability: string): Promise<'yes' | 'no' | null> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 5_000);
    try {
      const res = await fetchImpl(`${opts.baseUrl}/api/show`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model }),
        signal: ctl.signal,
      });
      if (!res.ok) return null;
      const j = (await res.json()) as { capabilities?: unknown };
      if (!Array.isArray(j.capabilities)) return null;
      return j.capabilities.includes(capability) ? 'yes' : 'no';
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // Resolve a model's support for `capability`, preferring Ollama's probe and
  // falling back to the tag heuristic when the probe is unavailable. The
  // tri-state matters: an authoritative 'no' (e.g. Gemma 2/3 thinking) is never
  // coerced — sending think:false to a non-thinking model errors the turn —
  // whereas a probe failure yields the family default ('unknown' for unknown
  // models) so an explicit per-turn override is still honoured.
  async function resolveCapability(
    model: string,
    capability: 'thinking' | 'vision',
    cache: Map<string, 'yes' | 'no'>,
  ): Promise<'yes' | 'no' | 'unknown'> {
    const cached = cache.get(model);
    if (cached) return cached;
    const probed = await probeCapability(model, capability);
    if (probed) {
      cache.set(model, probed);
      return probed;
    }
    return modelFamily(model)[capability];
  }

  // Public gate for attaching images to a turn. Only a definite 'yes' allows it;
  // 'unknown'/'no' fail closed (sending images to a text model errors the turn).
  async function supportsVision(model: string): Promise<boolean> {
    return (await resolveCapability(model, 'vision', visionCache)) === 'yes';
  }

  async function* chat(o: ChatOptions): AsyncIterable<ChatChunk> {
    checkBreaker();
    ensureIdleSweep();
    const target = resolveProfile(o.profile);
    // Mark a heavy inference in flight BEFORE eviction, not after. evictIfNeeded
    // and releaseHeavy both serialize on evictionLock; a releaseHeavy queued
    // behind THIS call's eviction otherwise runs in the microtask gap between
    // `await evictIfNeeded` resolving and this increment — it would see
    // residentHeavy already set but heavyInFlight still 0, and unload the model
    // we just made resident (a wasted unload + cold reload on the next fetch).
    // Incrementing first closes that gap: releaseHeavy then sees heavyInFlight > 0
    // and defers. evictIfNeeded never throws (unloadModel swallows its own
    // errors), so this can't leak; balanced by a decrement on every exit path
    // further down (fetch failure, non-2xx, and the streaming finally).
    const isHeavy = target.cfg?.heavy === true;
    if (isHeavy) heavyInFlight++;
    await evictIfNeeded(target);
    lastCallAt.set(target.profileName, now());

    // /no_think for thinking-capable families (qwen3). qwen3 is a thinking
    // model: by default it emits <think>…</think> blocks of hidden reasoning
    // that count toward eval_count but never reach the user. On CPU this
    // routinely burned hundreds of completion tokens producing nothing visible.
    // ATLAS pins think:false at the API level AND prepends /no_think to the
    // system prompt as belt-and-suspenders — we mirror both. Whether a model
    // thinks is resolved from Ollama's capability probe (Gemma 4 reasons,
    // Gemma 2/3 don't); non-thinking models skip this entirely.
    const thinkMode = o.thinkMode ?? target.cfg?.thinkMode ?? 'auto';
    const thinking = await resolveCapability(target.model, 'thinking', thinkingCache);
    // A model we *know* can't think (Gemma 2/3) is never suppressed — sending
    // Ollama's `think` parameter to it errors the turn. 'unknown' families keep
    // the historical behaviour: honour an explicit 'off', stay quiet on 'auto'.
    const suppressThink =
      thinking !== 'no' && (thinkMode === 'off' || (thinkMode === 'auto' && thinking === 'yes'));
    // Explicit 'on' for a model that can think: force think:true rather than
    // relying on the model's default. Without this, a reasoner left on its
    // default could vary (and the panel/per-agent "reason on" wouldn't be
    // deterministic). Never sent to a model we know can't think.
    const enableThink = thinking === 'yes' && thinkMode === 'on';
    let messages = o.messages;
    if (suppressThink) {
      const sysIdx = messages.findIndex((m) => m.role === 'system');
      if (sysIdx >= 0) {
        const sys = messages[sysIdx]!;
        if (!sys.content.startsWith('/no_think')) {
          messages = [
            ...messages.slice(0, sysIdx),
            { ...sys, content: '/no_think\n\n' + sys.content },
            ...messages.slice(sysIdx + 1),
          ];
        }
      } else {
        messages = [{ role: 'system', content: '/no_think' }, ...messages];
      }
    }

    const body: Record<string, unknown> = {
      model: target.model,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
        ...(m.tool_name ? { name: m.tool_name } : {}),
        ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
        ...(m.images && m.images.length > 0 ? { images: m.images } : {}),
      })),
      stream: true,
      keep_alive: target.cfg?.keepAlive ?? '5m',
      ...(suppressThink ? { think: false } : enableThink ? { think: true } : {}),
    };
    if (o.tools && o.tools.length > 0) body['tools'] = o.tools;
    // Per-call num_predict precedence: explicit maxTokens beats the profile
    // default. The profile default kicks in when the orchestrator doesn't ask
    // for anything specific, which is the common case.
    let predictCap = o.maxTokens ?? target.cfg?.numPredict;
    // Reasoning headroom. Thinking tokens count toward num_predict, so a small
    // tool/chat cap (e.g. 1024) gets entirely consumed by hidden reasoning and
    // the turn finishes with no visible answer — the failure behind big
    // reasoning models "finishing" empty. When the model will actually think
    // and the caller didn't pin an explicit maxTokens, raise an existing cap to
    // leave room for an answer after the reasoning. A caller-set cap (e.g. the
    // 256-token paraphrase followup) and an uncapped profile are left untouched.
    const REASONING_NUM_PREDICT_FLOOR = 4096;
    if (enableThink && o.maxTokens === undefined && predictCap !== undefined) {
      predictCap = Math.max(predictCap, REASONING_NUM_PREDICT_FLOOR);
    }
    const numBatch = target.cfg?.numBatch;
    if (target.cfg?.contextTokens || predictCap !== undefined || numBatch !== undefined) {
      body['options'] = {
        ...(target.cfg?.contextTokens ? { num_ctx: target.cfg.contextTokens } : {}),
        ...(predictCap !== undefined ? { num_predict: predictCap } : {}),
        ...(numBatch !== undefined ? { num_batch: numBatch } : {}),
      };
    }

    // Compose the caller's signal with our own timeout. Without a hard cap a
    // hung Ollama wedges the whole user queue.
    const effectiveTimeoutMs = o.timeoutMs ?? inferenceTimeoutMs;
    const timeoutCtl = new AbortController();
    // Set only when OUR timer fires, so the catch blocks can tell an inference
    // timeout (fail loud) from a caller /stop (clean cancel). o.signal.aborted
    // stays the source of truth for a real cancellation.
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      timeoutCtl.abort();
    }, effectiveTimeoutMs);
    const composed = o.signal ? composeAbort(o.signal, timeoutCtl.signal) : timeoutCtl.signal;

    let res: Response;
    try {
      res = await fetchImpl(`${opts.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: composed,
      });
    } catch (e) {
      clearTimeout(timeoutId);
      if (isHeavy) heavyInFlight--;
      // Our inference cap fired (not a caller /stop): surface it distinctly.
      if (timedOut && !o.signal?.aborted) throw new LLMTimeoutError(effectiveTimeoutMs);
      // A user-initiated /stop or process shutdown aborts the caller's signal,
      // which surfaces here as an AbortError. That isn't a backend failure, so
      // counting it would let three consecutive /stops trip the circuit breaker
      // and lock the bot out of its own LLM until the cooldown elapses.
      if (!(e instanceof Error && e.name === 'AbortError')) recordFailure(e);
      throw e;
    }
    if (!res.ok || !res.body) {
      clearTimeout(timeoutId);
      if (isHeavy) heavyInFlight--;
      recordFailure(new Error(`http ${res.status}`));
      const text = await res.text().catch(() => '');
      throw new LLMHttpError(res.status, `ollama responded ${res.status}: ${text}`);
    }

    let sawContent = false;
    let sawToolCall = false;
    // Reasoning-only output still means the model responded (transport + model
    // succeeded). Counting it keeps the empty-response guard from misfiring on a
    // turn that produced only `message.thinking` — the regression behind gemma
    // reasoners "finishing" with no visible answer. The orchestrator's own
    // safety net then retries for an actual answer when the content is empty.
    let sawThinking = false;
    // Whether we've already run the terminal success/empty-response accounting.
    let settled = false;
    // Empty-response guard: a successful stream that produced neither text nor a
    // tool call is almost always a model misfire (truncated, stuck on /think).
    // Surfacing it as an error lets the orchestrator say something useful
    // instead of streaming silent "(no reply)".
    const settleTerminal = (): void => {
      if (settled) return;
      settled = true;
      if (!sawContent && !sawToolCall && !sawThinking) {
        throw new LLMEmptyResponseError();
      }
      recordSuccess();
    };
    try {
      for await (const chunk of parseNdjsonStream(res.body, target.model, log)) {
        if (chunk.delta) sawContent = true;
        if (chunk.thinking) sawThinking = true;
        if (chunk.toolCalls && chunk.toolCalls.length > 0) sawToolCall = true;
        // Run the success/empty accounting *before* yielding the done chunk.
        // The orchestrator's drain loop breaks as soon as it sees done=true,
        // which runs this generator's return() and skips any code after the
        // for-await. Doing it here means recordSuccess() (which resets the
        // breaker's failure counter and is the only path that closes a
        // half-open breaker) and the empty-response guard still fire on the
        // normal production path, not just when a consumer drains to EOF.
        if (chunk.done) settleTerminal();
        yield chunk;
      }
      // Fallback for a stream that ended without an explicit done chunk.
      settleTerminal();
    } catch (e) {
      // Our inference cap fired mid-stream (not a caller /stop): fail loud.
      if (timedOut && !o.signal?.aborted) throw new LLMTimeoutError(effectiveTimeoutMs);
      // AbortError isn't a backend failure — don't trip the breaker for it.
      // LLMEmptyResponseError is the model's fault, not the transport's.
      if (
        !(e instanceof Error && e.name === 'AbortError') &&
        !(e instanceof LLMEmptyResponseError)
      ) {
        recordFailure(e);
      }
      throw e;
    } finally {
      clearTimeout(timeoutId);
      if (isHeavy) heavyInFlight--;
    }
  }

  async function health(): Promise<{ ok: boolean; models: string[] }> {
    try {
      const res = await fetchImpl(`${opts.baseUrl}/api/tags`);
      if (!res.ok) return { ok: false, models: [] };
      const j = (await res.json()) as { models?: Array<{ name: string }> };
      return { ok: true, models: (j.models ?? []).map((m) => m.name) };
    } catch {
      return { ok: false, models: [] };
    }
  }

  function listProfiles(): Record<ProfileName, ProfileConfig | null> {
    return {
      chat: profiles.chat ?? null,
      reason: profiles.reason ?? null,
      tools: profiles.tools ?? null,
    };
  }

  function resolveModel(p: ProfileName | { model: string }): string {
    return resolveProfile(p).model;
  }

  // Swap the model tag of each already-configured profile to match a new
  // Settings selection. Only existing slots are re-pointed: the orchestrator
  // resolves its tool/escalation profiles once at boot, so silently adding or
  // removing a slot here could leave it pointing at an absent profile — those
  // changes still want a restart. A stale resident heavy model (the old
  // reason tag) is left to evictIfNeeded on the next heavy call / the idle
  // sweep; we only touch the routing here.
  function updateModels(models: { chat?: string; reason?: string; tools?: string }): void {
    for (const name of ['chat', 'reason', 'tools'] as const) {
      const cfg = profiles[name];
      const next = models[name];
      if (cfg && next && next !== cfg.model) {
        profiles[name] = { ...cfg, model: next };
        log.info('llm profile model updated', { profile: name, model: next });
      }
    }
  }

  return {
    chat,
    health,
    listProfiles,
    resolveModel,
    updateModels,
    supportsVision,
    breakerSnapshot,
    stopIdleEviction,
    releaseHeavy,
  };
}

// Parse a single newline-delimited chunk. Returns null + logs on failure so
// the stream reader can skip a malformed line instead of crashing the turn.
function tryParseChunk(line: string, log?: Logger): OllamaChatChunk | null {
  try {
    return JSON.parse(line) as OllamaChatChunk;
  } catch (e) {
    log?.warn('ollama stream: malformed JSON line, skipping', {
      preview: line.slice(0, 100),
      error: e instanceof Error ? e.message : 'parse error',
    });
    return null;
  }
}

// Parse a tool-call argument JSON. Returns an empty object on failure so the
// tool runner sees a schema-validation error from the model rather than a
// thrown exception out of the stream iterator.
function tryParseToolArgs(raw: string, log?: Logger): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    log?.warn('ollama tool_call arguments JSON malformed, using empty object', {
      preview: raw.slice(0, 100),
      error: e instanceof Error ? e.message : 'parse error',
    });
    return {};
  }
}

function chunkFromParsed(parsed: OllamaChatChunk, fallbackModel: string, log?: Logger): ChatChunk {
  const chunk: ChatChunk = {
    delta: parsed.message?.content ?? '',
    done: !!parsed.done,
    model: parsed.model ?? fallbackModel,
  };
  if (parsed.message?.thinking) chunk.thinking = parsed.message.thinking;
  const toolCalls = parsed.message?.tool_calls;
  if (toolCalls && toolCalls.length > 0) {
    // Defensively skip any tool_call lacking a well-formed `function` block.
    // Ollama always sends one, but a partial/garbled line can parse as JSON
    // yet omit it; `tc.function.name` would then throw out of the stream
    // iterator and abort the whole turn. Skipping matches how tryParseChunk /
    // tryParseToolArgs tolerate other malformed stream data.
    const mapped = toolCalls
      .filter((tc) => tc?.function && typeof tc.function.name === 'string')
      .map((tc, i) => ({
        id: tc.id ?? `call_${i}_${Date.now()}`,
        name: tc.function.name,
        arguments:
          typeof tc.function.arguments === 'string'
            ? tryParseToolArgs(tc.function.arguments, log)
            : (tc.function.arguments ?? {}),
      }));
    if (mapped.length > 0) chunk.toolCalls = mapped;
  }
  if (parsed.prompt_eval_count !== undefined) chunk.promptTokens = parsed.prompt_eval_count;
  if (parsed.eval_count !== undefined) chunk.completionTokens = parsed.eval_count;
  return chunk;
}

// Parse Ollama's newline-delimited JSON stream into ChatChunks.
// Exported for tests; production code drives it via createOllama().chat().
export async function* parseNdjsonStream(
  body: ReadableStream<Uint8Array>,
  fallbackModel: string,
  log?: Logger,
): AsyncIterable<ChatChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const parsed = tryParseChunk(line, log);
        if (!parsed) continue;
        yield chunkFromParsed(parsed, fallbackModel, log);
      }
    }
    const tail = buffer.trim();
    if (tail) {
      const parsed = tryParseChunk(tail, log);
      if (parsed) {
        yield { ...chunkFromParsed(parsed, fallbackModel, log), done: true };
      }
    }
  } finally {
    // If the consumer stops early (e.g. /stop aborts mid-stream), the async
    // generator's return() runs this finally. Cancel the reader so the locked
    // body stream and its underlying connection are released promptly instead
    // of lingering until GC.
    await reader.cancel().catch(() => {});
  }
}

interface OllamaChatChunk {
  model?: string;
  done?: boolean;
  message?: {
    role?: string;
    content?: string;
    thinking?: string;
    tool_calls?: Array<{
      id?: string;
      function: { name: string; arguments: string | Record<string, unknown> };
    }>;
  };
  prompt_eval_count?: number;
  eval_count?: number;
}
