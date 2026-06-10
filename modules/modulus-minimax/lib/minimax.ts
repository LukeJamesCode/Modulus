import { parseSSEStream } from './sse.js';
import { toMinimaxMessages, toMinimaxTools } from './wire.js';
import type { ChatOptions, ChatChunk } from '../../../src/core/llm.js';
import type { Logger } from '../../../src/util/log.js';

export interface MinimaxApiOptions extends ChatOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
  log: Logger;
  fetchImpl?: typeof fetch;
}

export class MinimaxApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'MinimaxApiError';
  }
}

export async function* callMinimaxStream(opts: MinimaxApiOptions): AsyncIterable<ChatChunk> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = opts.baseUrl ?? 'https://api.minimaxi.chat/v1/text/chatcompletion_v2';

  const body: Record<string, unknown> = {
    model: opts.model,
    messages: toMinimaxMessages(opts.messages),
    stream: true,
  };

  const minimaxTools = toMinimaxTools(opts.tools);
  if (minimaxTools) {
    body.tools = minimaxTools;
  }

  if (opts.maxTokens !== undefined) {
    body.max_tokens = opts.maxTokens;
  }

  const timeoutCtl = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const timeoutId = setTimeout(() => timeoutCtl.abort(), timeoutMs);

  const signal = opts.signal;
  const onOuterAbort = () => timeoutCtl.abort();
  if (signal) {
    signal.addEventListener('abort', onOuterAbort);
    if (signal.aborted) timeoutCtl.abort();
  }

  try {
    const res = await fetchImpl(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: timeoutCtl.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new MinimaxApiError(res.status, `MiniMax HTTP ${res.status}: ${text}`);
    }

    if (!res.body) {
      throw new Error('MiniMax response had no body');
    }

    yield* parseSSEStream(res.body, opts.model, opts.log);
  } finally {
    clearTimeout(timeoutId);
    if (signal) {
      signal.removeEventListener('abort', onOuterAbort);
    }
  }
}
