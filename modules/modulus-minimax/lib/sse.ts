import type { Logger } from '../../../src/util/log.js';
import type { ChatChunk, ToolCall } from '../../../src/core/llm.js';
import { parseMinimaxToolCalls } from './wire.js';

interface MinimaxChunk {
  id?: string;
  choices?: Array<{
    index: number;
    finish_reason: string | null;
    delta?: {
      content?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  base_resp?: {
    status_code?: number;
    status_msg?: string;
  };
}

function tryParseChunk(line: string, log: Logger): MinimaxChunk | null {
  try {
    return JSON.parse(line) as MinimaxChunk;
  } catch (e) {
    log.warn('minimax stream: malformed JSON line, skipping', {
      preview: line.slice(0, 100),
      error: e instanceof Error ? e.message : 'parse error',
    });
    return null;
  }
}

interface AccumulatedToolCall {
  id?: string;
  name?: string;
  arguments: string;
}

export async function* parseSSEStream(
  body: ReadableStream<Uint8Array>,
  fallbackModel: string,
  log: Logger,
): AsyncIterable<ChatChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const toolCallAcc = new Map<number, AccumulatedToolCall>();

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);

        if (!line || line.startsWith(':')) continue;
        if (line === 'data: [DONE]') continue;
        if (!line.startsWith('data: ')) continue;

        const dataStr = line.slice(6).trim();
        if (!dataStr) continue;

        const parsed = tryParseChunk(dataStr, log);
        if (!parsed) continue;

        if (
          parsed.base_resp &&
          parsed.base_resp.status_code !== 0 &&
          parsed.base_resp.status_code !== undefined
        ) {
          throw new Error(
            `MiniMax API error: ${parsed.base_resp.status_msg} (${parsed.base_resp.status_code})`,
          );
        }

        const choice = parsed.choices?.[0];
        let deltaContent = '';
        if (choice?.delta?.content) {
          deltaContent = choice.delta.content;
        }

        if (choice?.delta?.tool_calls) {
          for (const tc of choice.delta.tool_calls) {
            const idx = tc.index ?? 0;
            let acc = toolCallAcc.get(idx);
            if (!acc) {
              acc = { arguments: '' };
              toolCallAcc.set(idx, acc);
            }
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name = tc.function.name;
            if (tc.function?.arguments) acc.arguments += tc.function.arguments;
          }
        }

        const isDone = choice?.finish_reason != null;
        let finalToolCalls: ToolCall[] | undefined = undefined;

        if (isDone && toolCallAcc.size > 0) {
          const rawCalls = Array.from(toolCallAcc.entries())
            .sort((a, b) => a[0] - b[0])
            .map(([_, acc]) => ({
              id: acc.id,
              function: { name: acc.name, arguments: acc.arguments },
            }));
          finalToolCalls = parseMinimaxToolCalls(rawCalls);
        }

        const chunk: ChatChunk = {
          delta: deltaContent,
          done: isDone,
          model: fallbackModel,
          ...(finalToolCalls ? { toolCalls: finalToolCalls } : {}),
        };

        if (parsed.usage) {
          if (parsed.usage.prompt_tokens !== undefined)
            chunk.promptTokens = parsed.usage.prompt_tokens;
          if (parsed.usage.completion_tokens !== undefined)
            chunk.completionTokens = parsed.usage.completion_tokens;
        }

        yield chunk;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
