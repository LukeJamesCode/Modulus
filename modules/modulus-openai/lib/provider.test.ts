import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Host } from '../../../src/core/modules.js';
import type { ChatChunk, ToolSchema } from '../../../src/core/llm.js';
import { open } from '../../../src/storage/db.js';
import { recordCall } from './budget.js';
import { createOpenAICompatibleProvider, resolveEndpointModel } from './provider.js';
import type { EndpointConfig, OpenAICompatSettings } from './settings.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationSql = readFileSync(join(here, '..', 'migrations', '0001_init.sql'), 'utf8');

const endpoint: EndpointConfig = {
  alias: 'deepseek',
  baseURL: 'https://api.deepseek.com/v1',
  apiKeySecret: 'secret://openai-compatible/deepseek',
  models: ['deepseek-chat', 'deepseek-reasoner'],
  supports: { tools: true, json_object: true, reasoning_field: 'reasoning_content' },
};

const settings: OpenAICompatSettings = {
  endpoints: [endpoint],
  allowedBaseURLs: [endpoint.baseURL],
  timeZone: 'UTC',
};

function streamFrom(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      const mid = Math.floor(text.length / 2);
      controller.enqueue(encoder.encode(text.slice(0, mid)));
      controller.enqueue(encoder.encode(text.slice(mid)));
      controller.close();
    },
  });
}

function sse(...payloads: Array<Record<string, unknown> | '[DONE]'>): ReadableStream<Uint8Array> {
  return streamFrom(
    payloads
      .map((payload) =>
        payload === '[DONE]' ? 'data: [DONE]\n\n' : `data: ${JSON.stringify(payload)}\n\n`,
      )
      .join(''),
  );
}

function freshHost(extraSettings: Record<string, string> = {}): Host & { cleanup: () => void } {
  const tmp = mkdtempSync(join(tmpdir(), 'oai-provider-'));
  const db = open({ path: join(tmp, 'g.db') });
  db.exec(migrationSql);
  const values = new Map<string, string>([
    ['secret_openai-compatible_deepseek', 'sk-test'],
    ...Object.entries(extraSettings),
  ]);
  const host = {
    db,
    settings: {
      get<T>(key: string, fallback?: T): T {
        return (values.get(key) ?? fallback) as T;
      },
      set(key: string, value: string | number | boolean): void {
        values.set(key, String(value));
      },
      all(): Record<string, string | number | boolean> {
        return Object.fromEntries(values);
      },
    },
    cleanup() {
      db.close();
      rmSync(tmp, { recursive: true, force: true });
    },
  } as unknown as Host & { cleanup: () => void };
  return host;
}

async function drain(chunks: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const chunk of chunks) out.push(chunk);
  return out;
}

test('resolveEndpointModel strips the alias prefix', () => {
  assert.equal(resolveEndpointModel(endpoint, 'deepseek:deepseek-reasoner'), 'deepseek-reasoner');
  assert.equal(resolveEndpointModel(endpoint, 'deepseek'), 'deepseek-chat');
});

test('streamed tool calls accumulate function arguments across SSE chunks', async () => {
  const host = freshHost();
  try {
    let request: unknown;
    const fetchImpl: typeof fetch = async (_url, init) => {
      request = JSON.parse(String(init?.body));
      return new Response(
        sse(
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_1',
                      type: 'function',
                      function: { name: 'lookup_weather', arguments: '{"city"' },
                    },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, function: { arguments: ':"Toronto"}' } }],
                },
              },
            ],
            usage: { prompt_tokens: 12, completion_tokens: 4 },
          },
          '[DONE]',
        ),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    };
    const provider = createOpenAICompatibleProvider(host, endpoint, settings, { fetchImpl });
    const tools: ToolSchema[] = [
      {
        type: 'function',
        function: {
          name: 'lookup_weather',
          description: 'Lookup weather',
          parameters: { type: 'object' },
        },
      },
    ];
    const chunks = await drain(
      provider.chat({
        model: 'deepseek:deepseek-chat',
        profile: { model: 'deepseek:deepseek-chat' },
        messages: [{ role: 'user', content: 'weather?' }],
        tools,
      }),
    );
    assert.ok((request as { tools?: unknown[] }).tools);
    const done = chunks.at(-1);
    assert.deepEqual(done?.toolCalls, [
      { id: 'call_1', name: 'lookup_weather', arguments: { city: 'Toronto' } },
    ]);
    assert.equal(done?.promptTokens, 12);
    assert.equal(done?.completionTokens, 4);
  } finally {
    host.cleanup();
  }
});

test('JSON-envelope fallback is used when native tools are disabled', async () => {
  const host = freshHost();
  try {
    let request = '';
    const noToolsEndpoint = { ...endpoint, supports: { tools: false, json_object: true } };
    const fetchImpl: typeof fetch = async (_url, init) => {
      request = String(init?.body);
      return new Response(
        sse(
          {
            choices: [
              {
                delta: {
                  content:
                    '{"tool_calls":[{"name":"lookup_weather","arguments":{"city":"Paris"}}]}',
                },
              },
            ],
          },
          '[DONE]',
        ),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    };
    const provider = createOpenAICompatibleProvider(host, noToolsEndpoint, settings, { fetchImpl });
    const chunks = await drain(
      provider.chat({
        model: 'deepseek:deepseek-chat',
        profile: { model: 'deepseek:deepseek-chat' },
        messages: [{ role: 'user', content: 'weather?' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'lookup_weather',
              description: 'Lookup weather',
              parameters: { type: 'object' },
            },
          },
        ],
      }),
    );
    assert.match(request, /LOCAL TOOL MANIFEST/);
    assert.doesNotMatch(request, /"tools":/);
    assert.deepEqual(chunks.at(-1)?.toolCalls, [
      {
        id: chunks.at(-1)?.toolCalls?.[0]?.id,
        name: 'lookup_weather',
        arguments: { city: 'Paris' },
      },
    ]);
  } finally {
    host.cleanup();
  }
});

test('reasoning field is normalized into streamed text', async () => {
  const host = freshHost();
  try {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        sse({ choices: [{ delta: { reasoning_content: 'think ', content: 'answer' } }] }, '[DONE]'),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    const provider = createOpenAICompatibleProvider(host, endpoint, settings, { fetchImpl });
    const chunks = await drain(
      provider.chat({
        model: 'deepseek:deepseek-reasoner',
        profile: { model: 'deepseek:deepseek-reasoner' },
        messages: [{ role: 'user', content: 'reason' }],
      }),
    );
    assert.equal(chunks.map((chunk) => chunk.delta).join(''), 'think answer');
  } finally {
    host.cleanup();
  }
});

test('success usage is recorded before consumers break on the done chunk', async () => {
  const host = freshHost();
  try {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        sse(
          { choices: [{ delta: { content: 'hello' } }] },
          { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } },
          '[DONE]',
        ),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    const provider = createOpenAICompatibleProvider(host, endpoint, settings, {
      fetchImpl,
      now: () => Date.UTC(2026, 4, 28, 12),
    });
    for await (const chunk of provider.chat({
      model: 'deepseek:deepseek-chat',
      profile: { model: 'deepseek:deepseek-chat' },
      messages: [{ role: 'user', content: 'hello' }],
    })) {
      if (chunk.done) break;
    }
    const row = host.db
      .prepare(
        `SELECT COUNT(*) AS n,
                COALESCE(SUM(prompt_tokens), 0) AS pt,
                COALESCE(SUM(completion_tokens), 0) AS ct
           FROM openai_compat_usage
          WHERE status = 'ok'`,
      )
      .get() as { n: number; pt: number; ct: number };
    assert.deepEqual(row, { n: 1, pt: 3, ct: 2 });
  } finally {
    host.cleanup();
  }
});

test('budget cap refuses loudly and records a denied row', async () => {
  const host = freshHost();
  try {
    recordCall(host.db, {
      day: '2026-05-28',
      endpointAlias: 'deepseek',
      source: 'llm',
      status: 'ok',
      now: Date.UTC(2026, 4, 28, 12),
    });
    const capped = { ...endpoint, dailyCallLimit: 1 };
    const provider = createOpenAICompatibleProvider(host, capped, settings, {
      now: () => Date.UTC(2026, 4, 28, 13),
      fetchImpl: async () => {
        throw new Error('fetch should not run');
      },
    });
    await assert.rejects(
      async () =>
        drain(
          provider.chat({
            model: 'deepseek:deepseek-chat',
            profile: { model: 'deepseek:deepseek-chat' },
            messages: [{ role: 'user', content: 'hello' }],
          }),
        ),
      /Daily budget reached/,
    );
    const denied = host.db
      .prepare(`SELECT COUNT(*) AS n FROM openai_compat_usage WHERE status = 'denied'`)
      .get() as { n: number };
    assert.equal(denied.n, 1);
  } finally {
    host.cleanup();
  }
});
