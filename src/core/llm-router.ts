import { LLMTimeoutError } from './llm.js';
import type {
  BreakerSnapshot,
  ChatChunk,
  ChatOptions,
  LLM,
  LLMProvider,
  ProfileConfig,
  ProfileName,
} from './llm.js';
import { composeAbort } from '../util/abort.js';

export interface RoutedLLM extends LLM {
  registerProvider(provider: LLMProvider): () => void;
}

export interface RoutedLLMOptions {
  // Hard cap (ms) applied to routed provider streams so a hung provider can't
  // wedge the user queue — the same guarantee createOllama() bakes in for the
  // base. A per-call ChatOptions.timeoutMs still overrides it. Providers do NOT
  // share the base's circuit breaker: that tracks Ollama-specific transport and
  // heavy-model state, and a flaky provider must not be able to trip it and lock
  // the bot out of Ollama. Beyond this timeout, a provider owns its own failure
  // semantics. Defaults to PROVIDER_DEFAULT_TIMEOUT_MS.
  providerTimeoutMs?: number;
}

// Matches createOllama()'s default inferenceTimeoutMs so a routed provider gets
// the same cap as the base when start.ts doesn't pass one through.
const PROVIDER_DEFAULT_TIMEOUT_MS = 120_000;

function providerMatches(provider: LLMProvider, model: string): boolean {
  return model === provider.id || model.startsWith(`${provider.id}:`);
}

export function createRoutedLLM(base: LLM, routedOpts: RoutedLLMOptions = {}): RoutedLLM {
  const providers = new Map<string, LLMProvider>();
  const providerTimeoutMs = routedOpts.providerTimeoutMs ?? PROVIDER_DEFAULT_TIMEOUT_MS;

  function providerFor(model: string): LLMProvider | undefined {
    for (const provider of providers.values()) {
      if (providerMatches(provider, model)) return provider;
    }
    return undefined;
  }

  function resolveModel(profile: ProfileName | { model: string }): string {
    return typeof profile === 'object' ? profile.model : base.resolveModel(profile);
  }

  // Wrap a provider stream with the shared inference cap. A provider's chat()
  // sits outside createOllama(), so it inherits none of the base's timeout — a
  // hung provider would hang the user queue exactly as an uncapped Ollama call
  // would. We compose the caller's signal (so /stop still cancels) with our own
  // timer and surface LLMTimeoutError distinctly, so the orchestrator fails loud
  // instead of mistaking the abort for a /stop. clearTimeout runs in finally,
  // which also fires when the consumer breaks early on the done chunk.
  async function* chatWithProviderTimeout(
    provider: LLMProvider,
    opts: ChatOptions,
    model: string,
  ): AsyncIterable<ChatChunk> {
    const effectiveTimeoutMs = opts.timeoutMs ?? providerTimeoutMs;
    const timeoutCtl = new AbortController();
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      timeoutCtl.abort();
    }, effectiveTimeoutMs);
    const signal = opts.signal ? composeAbort(opts.signal, timeoutCtl.signal) : timeoutCtl.signal;
    try {
      yield* provider.chat({ ...opts, model, signal });
    } catch (e) {
      // Our cap fired (not a caller /stop): surface it as the typed timeout.
      if (timedOut && !opts.signal?.aborted) throw new LLMTimeoutError(effectiveTimeoutMs);
      throw e;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  function chat(opts: ChatOptions): AsyncIterable<ChatChunk> {
    const model = resolveModel(opts.profile);
    const provider = providerFor(model);
    if (provider) return chatWithProviderTimeout(provider, opts, model);
    return base.chat(opts);
  }

  async function health(): Promise<{
    ok: boolean;
    models: string[];
    providers?: Record<string, { ok: boolean; models: string[] }>;
  }> {
    const baseHealth = await base.health();
    const providerHealth: Record<string, { ok: boolean; models: string[] }> = {
      ollama: { ok: baseHealth.ok, models: baseHealth.models },
    };
    const modelSet = new Set(baseHealth.models);
    let anyProviderOk = false;

    for (const provider of providers.values()) {
      const h = provider.health
        ? await provider.health()
        : { ok: true, models: provider.models?.() ?? [provider.id] };
      providerHealth[provider.id] = h;
      if (h.ok) anyProviderOk = true;
      for (const model of h.models) modelSet.add(model);
    }

    return {
      ok: baseHealth.ok || anyProviderOk,
      models: [...modelSet],
      providers: providerHealth,
    };
  }

  function listProfiles(): Record<ProfileName, ProfileConfig | null> {
    return base.listProfiles();
  }

  function breakerSnapshot(): BreakerSnapshot {
    return base.breakerSnapshot();
  }

  function stopIdleEviction(): void {
    base.stopIdleEviction();
  }

  // Heavy-model residency is the underlying Ollama instance's concern; routed
  // providers don't hold a resident heavy model. Defer to the base.
  async function releaseHeavy(): Promise<void> {
    await base.releaseHeavy?.();
  }

  // Vision capability is a property of the underlying Ollama model; registered
  // providers are routed by chat() and don't advertise it, so defer to the base.
  async function supportsVision(model: string): Promise<boolean> {
    return base.supportsVision ? base.supportsVision(model) : false;
  }

  function registerProvider(provider: LLMProvider): () => void {
    providers.set(provider.id, provider);
    return () => {
      if (providers.get(provider.id) === provider) providers.delete(provider.id);
    };
  }

  return {
    chat,
    health,
    listProfiles,
    resolveModel,
    supportsVision,
    breakerSnapshot,
    stopIdleEviction,
    releaseHeavy,
    registerProvider,
  };
}
