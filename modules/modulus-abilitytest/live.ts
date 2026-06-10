// Builds real LLMs from the user's config so the ability catalog can be scored
// against actual models, not the FakeLLM. Two profiles when both are available:
// the local Ollama chat model ("local") and Power Mode (an OpenAI-compatible
// alias, "power") whenever an endpoint is configured. In live mode the catalog's
// `script` is ignored — the real model decides — so this measures genuine
// tool-selection and delegation, not pipeline wiring.
//
// A live run needs Ollama running (and, for Power Mode, a configured endpoint +
// key in modulus-openai's settings). It is operator-run, never in CI.

import { createOllama } from '../../src/core/llm.js';
import type { LLM } from '../../src/core/llm.js';
import { createRoutedLLM } from '../../src/core/llm-router.js';
import type { DB } from '../../src/storage/db.js';
import type { Logger } from '../../src/util/log.js';
import type { Host } from '../../src/core/modules.js';
import { effectiveConfig } from '../../src/cli/config-store.js';
import { profilesForTier } from '../../src/cli/profiles.js';
import { readSettings } from '../modulus-openai/lib/settings.js';
import { createOpenAICompatibleProvider } from '../modulus-openai/lib/provider.js';

export interface LiveProfile {
  label: string;
  llm: LLM;
}

// Minimal Host facade exposing only what readSettings() and the OpenAI provider
// touch: the DB and module-scoped settings read from the live module_settings
// table (the same place the daemon's loader reads modulus-openai's config).
function openaiHost(db: DB): Host {
  const settings = {
    get<T>(key: string, fallback?: T): T {
      const row = db
        .prepare(`SELECT value FROM module_settings WHERE module = 'modulus-openai' AND key = ?`)
        .get(key) as { value: string } | undefined;
      return (row?.value ?? fallback) as T;
    },
    set(key: string, value: string | number | boolean): void {
      db.prepare(
        `INSERT INTO module_settings (module, key, value, updated_at)
         VALUES ('modulus-openai', ?, ?, ?)
         ON CONFLICT(module, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).run(key, String(value), Date.now());
    },
    all(): Record<string, string | number | boolean> {
      return {};
    },
  };
  return { db, settings } as unknown as Host;
}

function ollamaProfileLLM(
  baseUrl: string,
  tier: ReturnType<typeof effectiveConfig>['tier'],
  models: ReturnType<typeof effectiveConfig>['models'],
  log: Logger,
): ReturnType<typeof createRoutedLLM> {
  return createRoutedLLM(
    createOllama({ baseUrl, profiles: profilesForTier(tier, models).profiles, log }),
  );
}

export function buildLiveProfiles(opts: { db: DB; home: string; log: Logger }): LiveProfile[] {
  const cfg = effectiveConfig(opts.home);
  const out: LiveProfile[] = [];

  // Local / Pi: the configured small chat model on Ollama.
  out.push({
    label: `local:${cfg.models.chat}`,
    llm: ollamaProfileLLM(cfg.ollama.url, cfg.tier, cfg.models, opts.log),
  });

  // Power Mode: the first configured OpenAI-compatible endpoint, if any. The
  // 'chat' profile is repointed at that alias and the provider registered so the
  // router dispatches to it (the exact Power-Mode path the daemon uses).
  const host = openaiHost(opts.db);
  let endpoint;
  let settings;
  try {
    settings = readSettings(host);
    endpoint = settings.endpoints[0];
  } catch {
    endpoint = undefined;
  }
  const firstModel = endpoint?.models[0];
  if (settings && endpoint && firstModel) {
    const aliasModel = `${endpoint.alias}:${firstModel}`;
    const power = ollamaProfileLLM(
      cfg.ollama.url,
      cfg.tier,
      { ...cfg.models, chat: aliasModel },
      opts.log,
    );
    power.registerProvider(createOpenAICompatibleProvider(host, endpoint, settings));
    out.push({ label: `power:${aliasModel}`, llm: power });
  }

  return out;
}
