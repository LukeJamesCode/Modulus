// Dashboard chat: the browser turn runs through the daemon's own orchestrator
// pipeline — the same intercept chain → orchestrator path Telegram uses — and
// streams tokens back over SSE. Confirm-tier tools fired mid-turn render inline
// in the browser via the confirm bus (fail-closed on disconnect/timeout).
//
// Deferred to follow-ups: voice in/out, chat file attachments, and the post-turn
// afterReply/afterTurn hooks (they drive voice/learning modules that need a
// browser-side sink).

import { randomUUID } from 'node:crypto';
import type { DB } from '../../storage/db.js';
import type { ModulusConfig } from '../../cli/config-store.js';
import type { TelegramInterceptContext } from '../../core/modules.js';
import type { ThinkMode } from '../../core/llm.js';
import type { ToolContext, ToolHandler } from '../../core/tools.js';
import { readJson, sendJson, sse as sseWrite, writeSseHead } from '../http.js';
import type { RouteModule } from '../router.js';
import type { PanelDeps } from '../types.js';
import { createConfirmRegistry } from './confirm-registry.js';

// Matches the Telegram adapter's confirm timeout: an unanswered prompt fails
// closed after this long.
const CONFIRM_TIMEOUT_MS = 2 * 60_000;

function parseThinkMode(v: unknown): ThinkMode {
  return v === 'on' || v === 'off' || v === 'auto' ? v : 'auto';
}

// The owner chat/user the browser turn speaks as — the most recently seen chat
// of an allowlisted user, falling back to the first allowlisted id. Sharing the
// owner chatId means the panel and Telegram share one conversation history.
// Exported so the Channels-binding route binds the same chat the Dashboard runs.
export function ownerChat(db: DB, cfg: ModulusConfig): { chatId: number; userId: number } | null {
  const fallback = cfg.telegram.allowedIds[0];
  if (fallback === undefined) return null;
  const placeholders = cfg.telegram.allowedIds.map(() => '?').join(', ');
  const row = db
    .prepare(
      `SELECT chat_id AS chatId, user_id AS userId FROM telegram_chats
        WHERE user_id IN (${placeholders})
        ORDER BY last_seen_at DESC LIMIT 1`,
    )
    .get(...cfg.telegram.allowedIds) as { chatId: number; userId: number } | undefined;
  return row ?? { chatId: fallback, userId: fallback };
}

export function createChatRoutes(deps: PanelDeps): RouteModule {
  // Confirm prompts parked across every live stream. POST /api/chat/confirm
  // resolves by id (registry-global); each stream below takes its own scope so
  // finishing one stream only fails-closed its own confirms, not another tab's.
  const confirms = createConfirmRegistry();

  async function streamChat(
    req: Parameters<RouteModule>[0]['req'],
    res: Parameters<RouteModule>[0]['res'],
  ): Promise<void> {
    const body = await readJson<{ text?: string; thinkMode?: string }>(req);
    const text = (body.text ?? '').trim();
    if (!text) {
      sendJson(res, 400, { error: 'empty message' });
      return;
    }
    const owner = ownerChat(deps.db, deps.config);
    if (!owner) {
      sendJson(res, 500, { error: 'no owner chat configured' });
      return;
    }
    const { chatId, userId } = owner;
    const thinkMode = parseThinkMode(body.thinkMode);

    writeSseHead(res);
    const sse = (event: string, data: unknown): void => sseWrite(res, event, data);

    const controller = new AbortController();
    // This stream's own confirm scope. Cleanup below fails-closed only its
    // prompts — a sibling tab on the same chat keeps its own pending confirms.
    const confirmScope = confirms.scope();

    // Browser confirm renderer for this turn (A). Registered on the shared bus
    // so the daemon's confirm router routes this chatId's confirms here.
    const confirmFn = (
      handler: ToolHandler,
      args: Record<string, unknown>,
      ctx: ToolContext,
    ): Promise<boolean> => {
      if (controller.signal.aborted) return Promise.resolve(false);
      const id = randomUUID();
      let preview: string;
      try {
        preview = handler.confirmPrompt ? handler.confirmPrompt(args) : `Run ${handler.name}?`;
      } catch {
        preview = `Run ${handler.name}?`;
      }
      sse('confirm', { id, prompt: preview, tool: handler.name });
      return new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (ok: boolean): void => {
          if (settled) return;
          settled = true;
          confirmScope.remove(id);
          clearTimeout(timer);
          ctx.signal?.removeEventListener('abort', onAbort);
          resolve(ok);
        };
        const onAbort = (): void => finish(false);
        const timer = setTimeout(() => finish(false), CONFIRM_TIMEOUT_MS);
        timer.unref?.();
        ctx.signal?.addEventListener('abort', onAbort, { once: true });
        confirmScope.add(id, finish);
      });
    };
    deps.confirmBus.register(chatId, confirmFn);

    req.on('close', () => {
      controller.abort();
      deps.orchestrator.stop(chatId);
      // Fail closed: a disconnect mid-confirm must never leave a confirm-tier
      // tool waiting (and thus eligible to run) on a dead stream. Scoped to
      // THIS stream — a sibling tab's pending confirms stay alive.
      confirmScope.failAll();
    });

    let full = '';
    let orchestratorRan = false;

    // A bound owner conversation answers as its agent's persona orchestrator;
    // unbound (or no router) uses the default. Matches the Telegram dispatch
    // path. (stop/newChat below stay on the default instance — cancelling a
    // bound in-flight turn is a known follow-up, not a safety gap.)
    const turnOrchestrator = deps.conversationRouter?.orchestratorFor(chatId) ?? deps.orchestrator;

    const runOrchestrator = async (): Promise<void> => {
      orchestratorRan = true;
      await turnOrchestrator.handleUserMessage({
        chatId,
        userId,
        text,
        source: 'dashboard',
        ...(thinkMode !== 'auto' ? { thinkMode } : {}),
        send: (chunk) => {
          if (controller.signal.aborted) return;
          if (chunk.delta) {
            full += chunk.delta;
            sse('delta', { delta: chunk.delta });
          }
          if (chunk.thinking) sse('thinking', { thinking: chunk.thinking });
          if (chunk.done && chunk.replace !== undefined) {
            full = chunk.replace;
            sse('replace', { text: full });
          }
          if (chunk.done && chunk.meta) {
            sse('meta', {
              model: chunk.meta.model,
              elapsedMs: chunk.meta.elapsedMs,
              promptTokens: chunk.meta.promptTokens,
              completionTokens: chunk.meta.completionTokens,
              tools: chunk.meta.afterTurn?.toolCalls ?? [],
            });
          }
        },
      });
    };

    // Mirror the Telegram adapter: run the intercept chain first so modules
    // (e.g. instant responses) get first crack. An intercept that fully handles
    // the turn replies and never calls next(); one that just acks calls next()
    // and we fall through to the orchestrator.
    const intercepts = deps.loader.intercepts();
    let i = 0;
    const runNext = async (): Promise<void> => {
      const item = intercepts[i++];
      if (!item) {
        await runOrchestrator();
        return;
      }
      const ictx: TelegramInterceptContext = {
        chatId,
        userId,
        text,
        args: text,
        reply: async (t) => {
          if (controller.signal.aborted) return;
          sse('instant', { text: t });
        },
        next: runNext,
      };
      try {
        await item.handler(ictx);
      } catch (e) {
        deps.log.warn('panel chat intercept failed', {
          mod: item.module,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    };

    // Core instant response, mirroring the Telegram path: a 'reply' is terminal
    // (the orchestrator never runs); an 'ack' lands as its own bubble, then the
    // turn streams normally. The web renders an 'instant' frame as its own
    // message, so there's no double-reply race with the streamed answer.
    let instantTerminal = false;
    const instant = deps.instantResponder?.respond(text, chatId);
    if (instant) {
      sse('instant', { text: instant.text });
      if (instant.mode === 'reply') instantTerminal = true;
    }

    try {
      if (!instantTerminal) await runNext();
      sse('done', { text: orchestratorRan ? full : '' });
    } catch (e) {
      sse('error', { message: e instanceof Error ? e.message : String(e) });
    } finally {
      deps.confirmBus.unregister(chatId, confirmFn);
      confirmScope.failAll();
      res.end();
    }
  }

  return async ({ req, res, path, method }) => {
    if (path === '/api/chat' && method === 'POST') {
      await streamChat(req, res);
      return true;
    }

    if (path === '/api/chat/confirm' && method === 'POST') {
      const { id, ok } = await readJson<{ id?: string; ok?: boolean }>(req);
      const finish = id ? confirms.get(id) : undefined;
      if (!finish) {
        sendJson(res, 409, { ok: false, error: 'no confirmation is waiting' });
        return true;
      }
      finish(!!ok);
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (path === '/api/chat/clear' && method === 'POST') {
      const owner = ownerChat(deps.db, deps.config);
      if (owner) deps.orchestrator.newChat(owner.chatId);
      sendJson(res, 200, { ok: true });
      return true;
    }

    return false;
  };
}
