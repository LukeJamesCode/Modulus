// Settings routes: core config read/write, Ollama connectivity test, model
// list, Telegram token validation, and the hive-mind memory browser.
//
// Config writes persist to ~/.modulus/config.json; model/tier changes take
// effect on the next restart (they're read at boot), the same as the CLI.

import { totalmem } from 'node:os';
import {
  effectiveConfig,
  loadConfig,
  saveConfig,
  validateOllamaUrl,
  type ModulusConfig,
} from '../../cli/config-store.js';
import { availableModelTags } from '../../cli/model-options.js';
import { classifyProbeError, probeOllama } from '../../cli/ollama-probe.js';
import { readJson, sendJson } from '../http.js';
import type { RouteModule } from '../router.js';
import type { PanelDeps } from '../types.js';

function maskToken(token: string): string {
  if (!token) return '';
  if (token.length <= 12) return '••••••';
  return `${token.slice(0, 8)}${'•'.repeat(18)}${token.slice(-4)}`;
}

function suggestedTier(): NonNullable<ModulusConfig['tier']> {
  const ramGb = totalmem() / 1024 ** 3;
  return ramGb <= 4 ? 'small' : ramGb >= 16 ? 'heavy' : 'standard';
}

// Which settings are pinned by an environment variable — the UI greys these out
// because the file value would be ignored (env wins in effectiveConfig).
function envLocks(): Record<string, boolean> {
  const e = process.env;
  return {
    token: !!e['TELEGRAM_BOT_TOKEN']?.trim(),
    allowlist: !!e['TELEGRAM_ALLOWED_IDS']?.trim(),
    ollamaUrl: !!e['OLLAMA_URL']?.trim(),
    chatModel: !!e['MODULUS_CHAT_MODEL']?.trim(),
    reasonModel: !!e['MODULUS_REASON_MODEL']?.trim(),
    toolsModel: !!e['MODULUS_TOOLS_MODEL']?.trim(),
    tier: !!e['MODULUS_TIER']?.trim(),
    logLevel: !!e['MODULUS_LOG_LEVEL']?.trim(),
  };
}

export async function validateTelegram(token: string): Promise<unknown> {
  const t = token.trim();
  if (!/^[0-9]+:[A-Za-z0-9_-]{30,}$/.test(t)) {
    return { ok: false, error: 'Token has an invalid shape.' };
  }
  try {
    const r = await fetch(`https://api.telegram.org/bot${t}/getMe`);
    const j = (await r.json()) as {
      ok?: boolean;
      result?: { first_name?: string; username?: string };
    };
    if (!j.ok || !j.result) return { ok: false, error: 'getMe returned ok=false' };
    return {
      ok: true,
      botName: j.result.first_name ?? 'Modulus',
      botUser: j.result.username ? `@${j.result.username}` : '',
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function saveCoreConfig(
  home: string,
  body: Record<string, unknown>,
): { ok: boolean; error?: string } {
  const next = JSON.parse(JSON.stringify(loadConfig(home))) as ModulusConfig;

  if (typeof body['token'] === 'string' && body['token'] && !body['token'].includes('•')) {
    next.telegram.token = body['token'];
  }
  if (Array.isArray(body['allowlist'])) {
    next.telegram.allowedIds = (body['allowlist'] as unknown[])
      .map((v) => Number.parseInt(String(v), 10))
      .filter((n) => Number.isFinite(n));
  }
  if (typeof body['ollamaUrl'] === 'string' && body['ollamaUrl']) {
    try {
      validateOllamaUrl(body['ollamaUrl']);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    next.ollama.url = body['ollamaUrl'];
  }
  if (typeof body['chatModel'] === 'string' && body['chatModel'])
    next.models.chat = body['chatModel'];
  if (typeof body['reasoningModel'] === 'string') {
    if (body['reasoningModel']) next.models.reason = body['reasoningModel'];
    else delete next.models.reason;
  }
  if (typeof body['toolsModel'] === 'string') {
    if (body['toolsModel']) next.models.tools = body['toolsModel'];
    else delete next.models.tools;
  }
  if (typeof body['tier'] === 'string' && ['small', 'standard', 'heavy'].includes(body['tier'])) {
    next.tier = body['tier'] as ModulusConfig['tier'];
  }
  if (
    typeof body['logLevel'] === 'string' &&
    ['debug', 'info', 'warn', 'error'].includes(body['logLevel'])
  ) {
    next.logLevel = body['logLevel'] as ModulusConfig['logLevel'];
  }
  if (typeof body['instantResponses'] === 'boolean') {
    next.instantResponses = { enabled: body['instantResponses'] };
  }

  saveConfig(next, home);
  return { ok: true };
}

export function createSettingsRoutes(deps: PanelDeps): RouteModule {
  return async ({ req, res, url, path, method }) => {
    if (path === '/api/config' && method === 'GET') {
      const cfg = effectiveConfig(deps.home);
      sendJson(res, 200, {
        token: maskToken(cfg.telegram.token),
        hasToken: !!cfg.telegram.token,
        allowlist: cfg.telegram.allowedIds.map(String),
        ollamaUrl: cfg.ollama.url,
        chatModel: cfg.models.chat,
        reasoningModel: cfg.models.reason ?? '',
        toolsModel: cfg.models.tools ?? '',
        tier: cfg.tier ?? suggestedTier(),
        logLevel: cfg.logLevel ?? 'info',
        instantResponses: cfg.instantResponses?.enabled !== false,
        envLocks: envLocks(),
      });
      return true;
    }

    if (path === '/api/config' && method === 'POST') {
      const result = saveCoreConfig(deps.home, await readJson<Record<string, unknown>>(req));
      sendJson(res, result.ok ? 200 : 400, result.ok ? { ok: true } : { error: result.error });
      return true;
    }

    if (path === '/api/ollama/test' && method === 'POST') {
      const { url: ollamaUrl } = await readJson<{ url?: string }>(req);
      const target = ollamaUrl?.trim() || effectiveConfig(deps.home).ollama.url;
      try {
        validateOllamaUrl(target);
      } catch (e) {
        sendJson(res, 400, { ok: false, error: (e as Error).message });
        return true;
      }
      const probe = await probeOllama(target);
      sendJson(res, 200, { ...probe, errorKind: classifyProbeError(probe.error) });
      return true;
    }

    if (path === '/api/models' && method === 'GET') {
      const probe = await probeOllama(effectiveConfig(deps.home).ollama.url);
      const ollamaTags = availableModelTags(probe.ok ? probe.models : [], deps.home);
      // Power Mode: offer registered OpenAI-compatible provider aliases (e.g.
      // 'deepseek:deepseek-chat') so a profile can be pointed at a cloud endpoint
      // from Settings, not just at a locally-pulled Ollama tag.
      const models = [...new Set([...ollamaTags, ...deps.llm.providerModels()])];
      sendJson(res, 200, { ...probe, models });
      return true;
    }

    if (path === '/api/telegram/validate' && method === 'POST') {
      const { token } = await readJson<{ token?: string }>(req);
      sendJson(res, 200, await validateTelegram(token ?? ''));
      return true;
    }

    // ---- Hive-mind memory browser -------------------------------------------
    if (path === '/api/memory' && method === 'GET') {
      const q = (url.searchParams.get('q') ?? url.searchParams.get('query') ?? '').trim();
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100));
      const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
      const memories = q ? deps.memory.recall(q, limit) : deps.memory.list(limit, offset);
      sendJson(res, 200, { memories, total: deps.memory.count() });
      return true;
    }
    const memoryIdMatch = /^\/api\/memory\/(\d+)$/.exec(path);
    if (memoryIdMatch && method === 'DELETE') {
      const ok = deps.memory.remove(Number(memoryIdMatch[1]));
      sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'not found' });
      return true;
    }

    return false;
  };
}
