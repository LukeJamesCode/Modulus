// Shared handoff runner. Both the `codex_handoff` tool (qwen-initiated) and the
// `/codex` command (user-initiated) funnel through here so budget accounting,
// token refresh, prompt composition, and error shaping live in exactly one
// place.

import type { Host } from '../../../src/core/modules.js';
import { getValidAccessToken, CodexNotAuthedError } from './store.js';
import { callCodex, CodexApiError, type CodexResult } from './codex.js';
import { localDay, countToday, recordCall } from './budget.js';
import { recentTurns, formatHistory } from './history.js';

export interface HandoffInput {
  task: string;
  context?: string;
  successCriteria?: string;
  chatId?: number;
  // Conversation to pull recent turns from for context. The tool path gets this
  // from the ToolContext; the command path derives it from the chat id.
  conversationId?: number;
  source: 'tool' | 'command';
  signal?: AbortSignal;
}

export type HandoffOutcome =
  | { ok: true; result: CodexResult }
  // `denied` = a policy stop (not authed / over budget). The caller surfaces
  // `message` to the user; it is NOT a backend failure.
  | { ok: false; denied: true; message: string }
  | { ok: false; denied: false; message: string };

interface Settings {
  model: string;
  baseUrl: string;
  ceiling: number;
  maxOutputTokens: number;
  timeoutMs: number;
  contextTurns: number;
  contextMaxChars: number;
  timeZone?: string;
}

export function readSettings(host: Host): Settings {
  const tz = host.settings.get<string>('time_zone', '');
  const rawTurns = Number(host.settings.get<number>('context_turns', 6));
  const rawCtxChars = Number(host.settings.get<number>('context_max_chars', 4000));
  const s: Settings = {
    model: host.settings.get<string>('model', 'gpt-5.5') || 'gpt-5.5',
    baseUrl:
      host.settings.get<string>('base_url', 'https://chatgpt.com/backend-api/codex') ||
      'https://chatgpt.com/backend-api/codex',
    ceiling: Number(host.settings.get<number>('daily_call_ceiling', 20)) || 20,
    maxOutputTokens: Number(host.settings.get<number>('max_output_tokens', 4096)) || 4096,
    timeoutMs: Number(host.settings.get<number>('request_timeout_ms', 120_000)) || 120_000,
    contextTurns: Number.isFinite(rawTurns) ? Math.max(0, Math.floor(rawTurns)) : 6,
    contextMaxChars:
      Number.isFinite(rawCtxChars) && rawCtxChars > 0 ? Math.floor(rawCtxChars) : 4000,
  };
  if (tz) s.timeZone = tz;
  return s;
}

export function composePrompt(input: HandoffInput, history?: string): string {
  const parts = [`TASK:\n${input.task.trim()}`];
  if (input.context?.trim())
    parts.push(`\nCONTEXT (from the user / conversation):\n${input.context.trim()}`);
  if (history?.trim())
    parts.push(
      `\nRECENT CONVERSATION (chronological, for background — do the TASK above):\n${history.trim()}`,
    );
  if (input.successCriteria?.trim())
    parts.push(`\nSUCCESS CRITERIA:\n${input.successCriteria.trim()}`);
  return parts.join('\n');
}

// Human-readable wait string for a rate-limit reset.
function formatWait(seconds: number): string {
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const mins = Math.ceil(seconds / 60);
  if (mins < 60) return `${mins} min`;
  return `${Math.round(mins / 60)} h`;
}

export async function runHandoff(
  host: Host,
  input: HandoffInput,
  deps?: { fetchImpl?: typeof fetch; now?: () => number },
): Promise<HandoffOutcome> {
  const now = (deps?.now ?? Date.now)();
  const cfg = readSettings(host);
  const day = localDay(now, cfg.timeZone);

  // Budget gate first — cheapest check, and refusing early avoids a token
  // refresh we don't need.
  const used = countToday(host.db, day);
  if (used >= cfg.ceiling) {
    recordCall(host.db, {
      day,
      source: input.source,
      status: 'denied',
      now,
      ...(input.chatId !== undefined ? { chatId: input.chatId } : {}),
    });
    return {
      ok: false,
      denied: true,
      message: `Daily Codex budget reached (${cfg.ceiling}/${cfg.ceiling} calls used today). It resets at local midnight, or raise it with \`modulus config modulus-codex\`.`,
    };
  }

  // Auth + refresh.
  const tokenDeps: { fetchImpl?: typeof fetch; now?: () => number } = {};
  if (deps?.fetchImpl) tokenDeps.fetchImpl = deps.fetchImpl;
  if (deps?.now) tokenDeps.now = deps.now;
  let token;
  try {
    token = await getValidAccessToken(host, tokenDeps);
  } catch (e) {
    if (e instanceof CodexNotAuthedError) {
      return { ok: false, denied: true, message: e.message };
    }
    const msg = e instanceof Error ? e.message : String(e);
    recordCall(host.db, {
      day,
      source: input.source,
      status: 'error',
      now,
      ...(input.chatId !== undefined ? { chatId: input.chatId } : {}),
    });
    return { ok: false, denied: false, message: `Could not refresh Codex credentials: ${msg}` };
  }

  // Pull recent conversation turns so Codex has the context it can't otherwise
  // see. Best-effort: a failure here must never block the handoff.
  let history = '';
  if (cfg.contextTurns > 0 && input.conversationId !== undefined) {
    try {
      history = formatHistory(recentTurns(host.db, input.conversationId, cfg.contextTurns), {
        maxChars: cfg.contextMaxChars,
        exclude: input.task,
      });
    } catch (e) {
      host.log.warn('codex: failed to load conversation context', {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Call Codex.
  const callArgs: Parameters<typeof callCodex>[0] = {
    baseUrl: cfg.baseUrl,
    accessToken: token.accessToken,
    accountId: token.accountId,
    model: cfg.model,
    prompt: composePrompt(input, history),
    maxOutputTokens: cfg.maxOutputTokens,
    timeoutMs: cfg.timeoutMs,
  };
  if (deps?.fetchImpl) callArgs.fetchImpl = deps.fetchImpl;
  if (input.signal) callArgs.signal = input.signal;

  // On a 401 the token likely expired/was revoked between the pre-check above
  // and this call. Force one refresh + retry before giving up so a stale token
  // doesn't cost the user a manual re-auth.
  const callWithRetry = async (): Promise<CodexResult> => {
    try {
      return await callCodex(callArgs);
    } catch (e) {
      if (e instanceof CodexApiError && e.status === 401) {
        const refreshed = await getValidAccessToken(host, { ...tokenDeps, force: true });
        callArgs.accessToken = refreshed.accessToken;
        callArgs.accountId = refreshed.accountId;
        return await callCodex(callArgs);
      }
      throw e;
    }
  };

  try {
    const result = await callWithRetry();
    recordCall(host.db, {
      day,
      source: input.source,
      status: 'ok',
      now,
      ...(input.chatId !== undefined ? { chatId: input.chatId } : {}),
      ...(result.promptTokens !== undefined ? { promptTokens: result.promptTokens } : {}),
      ...(result.completionTokens !== undefined
        ? { completionTokens: result.completionTokens }
        : {}),
    });
    return { ok: true, result };
  } catch (e) {
    recordCall(host.db, {
      day,
      source: input.source,
      status: 'error',
      now,
      ...(input.chatId !== undefined ? { chatId: input.chatId } : {}),
    });
    if (e instanceof CodexApiError && e.status === 401) {
      return {
        ok: false,
        denied: false,
        message:
          'Codex rejected the credentials (401). The stored token may lack backend access — re-run `modulus auth modulus-codex`.',
      };
    }
    if (e instanceof CodexApiError && e.status === 429) {
      const wait = e.retryAfterSeconds
        ? ` Try again in about ${formatWait(e.retryAfterSeconds)}.`
        : '';
      return {
        ok: false,
        denied: false,
        message: `Codex is rate-limited by your ChatGPT plan right now.${wait}`,
      };
    }
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, denied: false, message: `Codex call failed: ${msg}` };
  }
}
