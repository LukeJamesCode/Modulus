import type { Host } from '../../../src/core/modules.js';
import type {
  ChatChunk,
  ChatMessage,
  LLMProvider,
  LLMProviderChatOptions,
  ToolCall,
  ToolSchema,
} from '../../../src/core/llm.js';
import { parseJsonSse } from './sse.js';
import { assertWithinBudget, localDay, recordCall } from './budget.js';
import { resolveSecret } from './secrets.js';
import type { EndpointConfig, OpenAICompatSettings } from './settings.js';

interface ProviderDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface OpenAIToolCallWire {
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface OpenAIChoiceWire {
  delta?: Record<string, unknown> & {
    content?: string | null;
    tool_calls?: Array<{
      index?: number;
      id?: string;
      type?: 'function';
      function?: {
        name?: string;
        arguments?: string;
      };
    }>;
  };
  message?: Record<string, unknown> & {
    content?: string | null;
    tool_calls?: OpenAIToolCallWire[];
  };
  finish_reason?: string | null;
}

interface OpenAIChunkWire {
  id?: string;
  model?: string;
  choices?: OpenAIChoiceWire[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  } | null;
}

interface ToolCallAccumulator {
  id?: string;
  name?: string;
  arguments: string;
}

export function resolveEndpointModel(endpoint: EndpointConfig, modelRef: string): string {
  const prefix = `${endpoint.alias}:`;
  if (modelRef.startsWith(prefix) && modelRef.length > prefix.length) {
    return modelRef.slice(prefix.length);
  }
  return endpoint.models[0] ?? modelRef;
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function formatTools(tools: readonly ToolSchema[] | undefined): string {
  if (!tools || tools.length === 0) return '';
  const lines = tools.map((tool) => {
    const fn = tool.function;
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

export function parseJsonEnvelopeToolCalls(
  text: string,
  tools: readonly ToolSchema[] | undefined,
): ToolCall[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  const allowed = new Set(tools.map((tool) => tool.function.name));
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
      id: `oai_json_${out.length}_${Date.now()}`,
      name: c.name,
      arguments:
        c.arguments && typeof c.arguments === 'object' && !Array.isArray(c.arguments)
          ? (c.arguments as Record<string, unknown>)
          : {},
    });
  }
  return out.length > 0 ? out : undefined;
}

function messageToOpenAI(message: ChatMessage): Record<string, unknown> {
  return {
    role: message.role,
    content: message.content,
    ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
    ...(message.tool_name ? { name: message.tool_name } : {}),
    ...(message.tool_calls
      ? {
          tool_calls: message.tool_calls.map((call) => ({
            id: call.id,
            type: 'function',
            function: {
              name: call.name,
              arguments: JSON.stringify(call.arguments),
            },
          })),
        }
      : {}),
  };
}

function applyJsonEnvelopeFallback(
  messages: readonly ChatMessage[],
  tools: readonly ToolSchema[] | undefined,
): Record<string, unknown>[] {
  const formatted = formatTools(tools);
  if (!formatted) return messages.map(messageToOpenAI);
  const mapped = messages.map(messageToOpenAI);
  for (let i = mapped.length - 1; i >= 0; i--) {
    if (mapped[i]?.['role'] === 'user') {
      mapped[i] = { ...mapped[i], content: String(mapped[i]?.['content'] ?? '') + formatted };
      return mapped;
    }
  }
  return [...mapped, { role: 'user', content: formatted.trim() }];
}

function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}') as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function materializeToolCalls(acc: Map<number, ToolCallAccumulator>): ToolCall[] | undefined {
  const out: ToolCall[] = [];
  for (const [index, call] of [...acc.entries()].sort((a, b) => a[0] - b[0])) {
    if (!call.name) continue;
    out.push({
      id: call.id ?? `oai_${index}_${Date.now()}`,
      name: call.name,
      arguments: parseToolArguments(call.arguments),
    });
  }
  return out.length > 0 ? out : undefined;
}

function reasoningDelta(choice: OpenAIChoiceWire, endpoint: EndpointConfig): string {
  const field = endpoint.supports.reasoning_field;
  if (!field) return '';
  const source = choice.delta ?? choice.message;
  const value = source?.[field];
  return typeof value === 'string' ? value : '';
}

function buildRequestBody(
  endpoint: EndpointConfig,
  opts: LLMProviderChatOptions,
  model: string,
  fallbackTools: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages: fallbackTools
      ? applyJsonEnvelopeFallback(opts.messages, opts.tools)
      : opts.messages.map(messageToOpenAI),
    stream: true,
    stream_options: { include_usage: true },
  };
  if (opts.maxTokens ?? endpoint.maxOutputTokens) {
    body['max_tokens'] = opts.maxTokens ?? endpoint.maxOutputTokens;
  }
  if (opts.tools && opts.tools.length > 0 && endpoint.supports.tools) {
    body['tools'] = opts.tools;
  }
  if (fallbackTools && endpoint.supports.json_object) {
    body['response_format'] = { type: 'json_object' };
  }
  return body;
}

function ensureAllowed(endpoint: EndpointConfig, settings: OpenAICompatSettings): void {
  if (!settings.allowedBaseURLs.includes(endpoint.baseURL)) {
    throw new Error(
      `${endpoint.alias} baseURL ${endpoint.baseURL} is not in this extension install's network allowlist. Re-run \`modulus ext update modulus-openai\` or intentionally add it to allowed_base_urls to widen capabilities.`,
    );
  }
}

export function createOpenAICompatibleProvider(
  host: Host,
  endpoint: EndpointConfig,
  settings: OpenAICompatSettings,
  deps: ProviderDeps = {},
): LLMProvider {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;

  async function* chat(opts: LLMProviderChatOptions): AsyncIterable<ChatChunk> {
    ensureAllowed(endpoint, settings);
    const day = localDay(now(), settings.timeZone);
    try {
      assertWithinBudget(host.db, {
        day,
        endpointAlias: endpoint.alias,
        dailyCallLimit: endpoint.dailyCallLimit,
        dailyTokenLimit: endpoint.dailyTokenLimit,
      });
    } catch (e) {
      recordCall(host.db, {
        day,
        endpointAlias: endpoint.alias,
        source: 'llm',
        status: 'denied',
        now: now(),
        ...(opts.context?.chatId !== undefined ? { chatId: opts.context.chatId } : {}),
      });
      throw e;
    }

    const model = resolveEndpointModel(endpoint, opts.model);
    const fallbackTools = !!opts.tools?.length && !endpoint.supports.tools;
    const body = buildRequestBody(endpoint, opts, model, fallbackTools);
    const timeoutCtl = new AbortController();
    const timeoutId = setTimeout(
      () => timeoutCtl.abort(),
      opts.timeoutMs ?? endpoint.timeoutMs ?? 120_000,
    );
    const signal = opts.signal
      ? AbortSignal.any([opts.signal, timeoutCtl.signal])
      : timeoutCtl.signal;

    let promptTokens: number | undefined;
    let completionTokens: number | undefined;
    let buffered = '';
    const toolAcc = new Map<number, ToolCallAccumulator>();

    try {
      const res = await fetchImpl(`${trimSlash(endpoint.baseURL)}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${resolveSecret(host, endpoint.apiKeySecret)}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal,
      });
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '');
        throw new Error(`${endpoint.alias} responded ${res.status}: ${text}`);
      }

      for await (const chunk of parseJsonSse<OpenAIChunkWire>(res.body)) {
        if (chunk.usage) {
          promptTokens = chunk.usage.prompt_tokens;
          completionTokens = chunk.usage.completion_tokens;
        }
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        for (const call of choice.delta?.tool_calls ?? []) {
          const index = call.index ?? toolAcc.size;
          const existing = toolAcc.get(index) ?? { arguments: '' };
          if (call.id) existing.id = call.id;
          if (call.function?.name) existing.name = call.function.name;
          if (call.function?.arguments) existing.arguments += call.function.arguments;
          toolAcc.set(index, existing);
        }
        const textDelta = reasoningDelta(choice, endpoint) + (choice.delta?.content ?? '');
        if (fallbackTools) {
          buffered += textDelta;
        } else if (textDelta) {
          yield { delta: textDelta, done: false, model: `${endpoint.alias}:${model}` };
        }
      }

      let toolCalls = materializeToolCalls(toolAcc);
      let finalChunk: ChatChunk;
      if (fallbackTools) {
        toolCalls = parseJsonEnvelopeToolCalls(buffered, opts.tools);
        finalChunk = {
          delta: toolCalls ? '' : buffered,
          done: true,
          model: `${endpoint.alias}:${model}`,
          ...(toolCalls ? { toolCalls } : {}),
          ...(promptTokens !== undefined ? { promptTokens } : {}),
          ...(completionTokens !== undefined ? { completionTokens } : {}),
        };
      } else {
        finalChunk = {
          delta: '',
          done: true,
          model: `${endpoint.alias}:${model}`,
          ...(toolCalls ? { toolCalls } : {}),
          ...(promptTokens !== undefined ? { promptTokens } : {}),
          ...(completionTokens !== undefined ? { completionTokens } : {}),
        };
      }

      recordCall(host.db, {
        day,
        endpointAlias: endpoint.alias,
        source: 'llm',
        status: 'ok',
        now: now(),
        ...(opts.context?.chatId !== undefined ? { chatId: opts.context.chatId } : {}),
        ...(promptTokens !== undefined ? { promptTokens } : {}),
        ...(completionTokens !== undefined ? { completionTokens } : {}),
      });
      yield finalChunk;
    } catch (e) {
      if (!(e instanceof Error && e.name === 'AbortError')) {
        recordCall(host.db, {
          day,
          endpointAlias: endpoint.alias,
          source: 'llm',
          status: 'error',
          now: now(),
          ...(opts.context?.chatId !== undefined ? { chatId: opts.context.chatId } : {}),
        });
      }
      throw e;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  return {
    id: endpoint.alias,
    models: () => [endpoint.alias, ...endpoint.models.map((model) => `${endpoint.alias}:${model}`)],
    health: async () => ({
      ok: true,
      models: [endpoint.alias, ...endpoint.models.map((model) => `${endpoint.alias}:${model}`)],
    }),
    chat,
  };
}
