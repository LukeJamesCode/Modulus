import type { Host } from '../../../src/core/modules.js';
import type {
  ChatMessage,
  LLMProvider,
  LLMProviderChatOptions,
  ToolCall,
  ToolSchema,
} from '../../../src/core/llm.js';
import { localDay, countToday, recordCall } from './budget.js';
import { callCodex, CodexApiError, type CodexResult } from './codex.js';
import { getValidAccessToken, CodexNotAuthedError, readTokens } from './store.js';
import { readSettings } from './run.js';

const ALIAS = 'codex';

function resolveCodexModel(modelRef: string, fallback: string): string {
  const prefix = `${ALIAS}:`;
  if (modelRef.startsWith(prefix) && modelRef.length > prefix.length) {
    return modelRef.slice(prefix.length);
  }
  return fallback;
}

function formatMessages(messages: readonly ChatMessage[]): string {
  return messages
    .map((m) => {
      const name = m.tool_name ? ` ${m.tool_name}` : '';
      return `${m.role.toUpperCase()}${name}:\n${m.content.trim()}`;
    })
    .join('\n\n');
}

function formatTools(tools: readonly ToolSchema[] | undefined): string {
  if (!tools || tools.length === 0) return '';
  const lines = tools.map((t) => {
    const fn = t.function;
    return `- ${fn.name}: ${fn.description}`;
  });
  return (
    '\n\nLOCAL TOOL MANIFEST:\n' +
    lines.join('\n') +
    '\nIf the latest user request should use one of these local tools, reply ONLY as JSON in this shape: ' +
    '{"tool_calls":[{"name":"tool_name","arguments":{}}]}. Do not wrap it in Markdown. ' +
    'If no tool is needed, answer normally. You cannot execute tools yourself; this JSON asks Modulus to run them locally.'
  );
}

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fence?.[1]?.trim() ?? trimmed;
}

function parseToolCalls(
  text: string,
  tools: readonly ToolSchema[] | undefined,
): ToolCall[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  const allowed = new Set(tools.map((t) => t.function.name));
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFence(text));
  } catch {
    return undefined;
  }
  const calls = (parsed as { tool_calls?: unknown })?.tool_calls;
  if (!Array.isArray(calls)) return undefined;
  const out: ToolCall[] = [];
  for (const call of calls) {
    const c = call as { name?: unknown; arguments?: unknown };
    if (typeof c.name !== 'string' || !allowed.has(c.name)) continue;
    out.push({
      id: `codex_${out.length}_${Date.now()}`,
      name: c.name,
      arguments:
        c.arguments && typeof c.arguments === 'object' && !Array.isArray(c.arguments)
          ? (c.arguments as Record<string, unknown>)
          : {},
    });
  }
  return out.length > 0 ? out : undefined;
}

function composeModelPrompt(opts: LLMProviderChatOptions): string {
  return (
    'Continue this Modulus conversation. Use the messages exactly as the conversation context, ' +
    'answer the latest user request, and do not mention this handoff unless it matters.\n\n' +
    formatMessages(opts.messages) +
    formatTools(opts.tools)
  );
}

function formatWait(seconds: number): string {
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const mins = Math.ceil(seconds / 60);
  if (mins < 60) return `${mins} min`;
  return `${Math.round(mins / 60)} h`;
}

async function callAsModel(host: Host, opts: LLMProviderChatOptions): Promise<CodexResult> {
  const now = Date.now();
  const cfg = readSettings(host);
  const day = localDay(now, cfg.timeZone);
  const used = countToday(host.db, day);
  if (used >= cfg.ceiling) {
    recordCall(host.db, {
      day,
      source: 'command',
      status: 'denied',
      now,
      ...(opts.context?.chatId !== undefined ? { chatId: opts.context.chatId } : {}),
    });
    throw new Error(
      `Daily Codex budget reached (${cfg.ceiling}/${cfg.ceiling} calls used today). It resets at local midnight, or raise it with \`modulus config modulus-codex\`.`,
    );
  }

  let token;
  try {
    token = await getValidAccessToken(host);
  } catch (e) {
    if (e instanceof CodexNotAuthedError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    recordCall(host.db, {
      day,
      source: 'command',
      status: 'error',
      now,
      ...(opts.context?.chatId !== undefined ? { chatId: opts.context.chatId } : {}),
    });
    throw new Error(`Could not refresh Codex credentials: ${msg}`);
  }

  const callArgs: Parameters<typeof callCodex>[0] = {
    baseUrl: cfg.baseUrl,
    accessToken: token.accessToken,
    accountId: token.accountId,
    model: resolveCodexModel(opts.model, cfg.model),
    prompt: composeModelPrompt(opts),
    maxOutputTokens: opts.maxTokens ?? cfg.maxOutputTokens,
    timeoutMs: cfg.timeoutMs,
  };
  if (opts.signal) callArgs.signal = opts.signal;

  const callWithRetry = async (): Promise<CodexResult> => {
    try {
      return await callCodex(callArgs);
    } catch (e) {
      if (e instanceof CodexApiError && e.status === 401) {
        const refreshed = await getValidAccessToken(host, { force: true });
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
      source: 'command',
      status: 'ok',
      now,
      ...(opts.context?.chatId !== undefined ? { chatId: opts.context.chatId } : {}),
      ...(result.promptTokens !== undefined ? { promptTokens: result.promptTokens } : {}),
      ...(result.completionTokens !== undefined
        ? { completionTokens: result.completionTokens }
        : {}),
    });
    return result;
  } catch (e) {
    recordCall(host.db, {
      day,
      source: 'command',
      status: 'error',
      now,
      ...(opts.context?.chatId !== undefined ? { chatId: opts.context.chatId } : {}),
    });
    if (e instanceof CodexApiError && e.status === 429) {
      const wait = e.retryAfterSeconds
        ? ` Try again in about ${formatWait(e.retryAfterSeconds)}.`
        : '';
      throw new Error(`Codex is rate-limited by your ChatGPT plan right now.${wait}`);
    }
    if (e instanceof CodexApiError && e.status === 401) {
      throw new Error('Codex rejected the credentials (401). Re-run `modulus auth modulus-codex`.');
    }
    throw e;
  }
}

export function createCodexModelProvider(host: Host): LLMProvider {
  return {
    id: ALIAS,
    models: () => {
      const cfg = readSettings(host);
      return [ALIAS, `${ALIAS}:${cfg.model}`];
    },
    health: async () => {
      const cfg = readSettings(host);
      const ok = readTokens(host) !== null;
      return { ok, models: [ALIAS, `${ALIAS}:${cfg.model}`] };
    },
    chat: async function* (opts) {
      const result = await callAsModel(host, opts);
      const toolCalls = parseToolCalls(result.text, opts.tools);
      yield {
        delta: toolCalls ? '' : result.text,
        done: true,
        model: `${ALIAS}:${resolveCodexModel(opts.model, readSettings(host).model)}`,
        ...(toolCalls ? { toolCalls } : {}),
        ...(result.promptTokens !== undefined ? { promptTokens: result.promptTokens } : {}),
        ...(result.completionTokens !== undefined
          ? { completionTokens: result.completionTokens }
          : {}),
      };
    },
  };
}
