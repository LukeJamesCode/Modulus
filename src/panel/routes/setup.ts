// Setup routes: the wizard-only surface that only exists (or only fully works)
// while the daemon is in setup mode.
//
//   POST /api/telegram/pair          — start a pairing session, return the code
//   GET  /api/telegram/pair/status   — poll pairing state (waiting/paired/…)
//   POST /api/telegram/pair/cancel   — abort the active session
//   GET  /api/ollama/pull-stream     — SSE-stream an `ollama pull` (also useful
//                                      from Settings later, so registered always)
//   POST /api/setup/complete         — preflight, then resolve promotion ~100ms
//                                      after the response flushes
//
// Pairing transport: a host-supplied shared manager (full mode) wins; otherwise
// a setup-mode getUpdates manager is created here. Absent both → /pair is 409.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { effectiveConfig, validateOllamaUrl } from '../../cli/config-store.js';
import { readJson, sendJson, sse, writeSseHead } from '../http.js';
import { createPairingManager, type PairingManager } from '../telegram-pairing.js';
import type { RouteModule } from '../router.js';
import type { PanelDeps } from '../types.js';

// Same shape Ollama accepts for a model tag: name[:tag] with the registry path
// chars. Guards the SSRF-adjacent pull endpoint against a hostile `?model=`.
const MODEL_TAG_RE = /^[a-zA-Z0-9._\-:/]+$/;
const TOKEN_RE = /^[0-9]+:[A-Za-z0-9_-]{30,}$/;

export function createSetupRoutes(deps: PanelDeps): RouteModule {
  // Resolve the pairing transport once. A host-supplied manager (full mode,
  // adapter-backed) takes precedence; in setup mode we run our own getUpdates
  // loop. Null when neither applies — /pair then fails closed with 409.
  const pairing: PairingManager | null =
    deps.pairing ?? (deps.setup ? createPairingManager({ db: deps.db, log: deps.log }) : null);

  return async ({ req, res, url, path, method }) => {
    if (path === '/api/telegram/pair' && method === 'POST') {
      if (!pairing) {
        sendJson(res, 409, { error: 'pairing is not available in this mode' });
        return true;
      }
      const { token } = await readJson<{ token?: string }>(req);
      const t = (token ?? '').trim();
      if (!TOKEN_RE.test(t)) {
        sendJson(res, 400, { error: 'Token has an invalid shape.' });
        return true;
      }
      const r = await pairing.start(t);
      if (!r.ok) {
        sendJson(res, 400, { error: r.error ?? 'Could not start pairing.' });
        return true;
      }
      sendJson(res, 200, {
        ok: true,
        code: r.code,
        botUser: r.botUser,
        botName: r.botName,
        expiresAt: r.expiresAt,
      });
      return true;
    }

    if (path === '/api/telegram/pair/status' && method === 'GET') {
      if (!pairing) {
        sendJson(res, 409, { error: 'pairing is not available in this mode' });
        return true;
      }
      sendJson(res, 200, pairing.status());
      return true;
    }

    if (path === '/api/telegram/pair/cancel' && method === 'POST') {
      pairing?.stop();
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (path === '/api/ollama/pull-stream' && method === 'GET') {
      await streamOllamaPull(deps, req, res, url.searchParams.get('model') ?? '');
      return true;
    }

    if (path === '/api/setup/complete' && method === 'POST') {
      if (!deps.setup) {
        sendJson(res, 409, { error: 'not in setup mode' });
        return true;
      }
      const pre = preflightSetup(deps);
      if (!pre.ok) {
        sendJson(res, 400, { error: pre.error });
        return true;
      }
      sendJson(res, 200, { ok: true });
      pairing?.stop();
      // Resolve promotion just after the response flushes, mirroring the
      // /api/agent/stop pattern — the wizard needs the 200 in hand before the
      // server starts tearing itself down for the full-daemon boot.
      const setup = deps.setup;
      setTimeout(() => setup.complete(), 100).unref();
      return true;
    }

    return false;
  };
}

// Config-shape preflight for promotion. We deliberately do NOT do a live getMe
// here: the wizard already validated the token live (POST /api/telegram/validate
// and the pairing getMe), and a getMe at this point would mostly catch the
// offline-after-pairing case — which we explicitly don't want to block on. So we
// check only what a malformed env/file edit could break: token shape, at least
// one allowlisted id, and that the config still loads.
function preflightSetup(deps: PanelDeps): { ok: true } | { ok: false; error: string } {
  let cfg;
  try {
    cfg = effectiveConfig(deps.home);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (!cfg.telegram.token || !TOKEN_RE.test(cfg.telegram.token)) {
    return { ok: false, error: 'Add a valid Telegram bot token before starting.' };
  }
  if (cfg.telegram.allowedIds.length === 0) {
    return { ok: false, error: 'Add at least one allowed person before starting.' };
  }
  return { ok: true };
}

// Translate Ollama's NDJSON `/api/pull` stream into the unnamed SSE frames the
// wizard's EventSource reader consumes. Mirrors the enable-stream route's
// keep-alive + req.on('close') + abort shape.
async function streamOllamaPull(
  deps: PanelDeps,
  req: IncomingMessage,
  res: ServerResponse,
  model: string,
): Promise<void> {
  writeSseHead(res);
  const send = (data: unknown): void => sse(res, null, data);
  if (!MODEL_TAG_RE.test(model)) {
    send({ type: 'done', ok: false, error: 'invalid model tag' });
    res.end();
    return;
  }
  let ollamaUrl: string;
  try {
    ollamaUrl = effectiveConfig(deps.home).ollama.url;
    validateOllamaUrl(ollamaUrl);
  } catch (e) {
    send({ type: 'done', ok: false, error: e instanceof Error ? e.message : String(e) });
    res.end();
    return;
  }

  const ac = new AbortController();
  const keepAlive = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* client gone */
    }
  }, 20_000);
  keepAlive.unref?.();
  req.on('close', () => {
    clearInterval(keepAlive);
    ac.abort();
  });

  try {
    const upstream = await fetch(`${ollamaUrl.replace(/\/+$/, '')}/api/pull`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, stream: true }),
      signal: ac.signal,
    });
    if (!upstream.ok || !upstream.body) {
      send({ type: 'done', ok: false, error: `ollama returned http ${upstream.status}` });
      return;
    }
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let errored: string | null = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let obj: { status?: string; total?: number; completed?: number; error?: string };
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        if (obj.error) {
          errored = obj.error;
          send({ type: 'progress', status: `error: ${obj.error}` });
          continue;
        }
        send({
          type: 'progress',
          status: obj.status ?? '',
          ...(typeof obj.total === 'number' ? { total: obj.total } : {}),
          ...(typeof obj.completed === 'number' ? { completed: obj.completed } : {}),
        });
      }
    }
    send({ type: 'done', ok: !errored, ...(errored ? { error: errored } : {}) });
  } catch (e) {
    if (!ac.signal.aborted) {
      send({ type: 'done', ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  } finally {
    clearInterval(keepAlive);
    res.end();
  }
}
