// Power Mode integration test: the end-to-end contract that makes modulus-openai
// a first-class configuration rather than "just a tool". It proves that a core
// PROFILE (chat/tools/reason) configured with a provider alias as its model tag
// routes — through the real createRoutedLLM — to the real OpenAI-compatible
// provider, and that streaming + tool calls survive the whole path. The provider
// and the router are each unit-tested in isolation (provider.test.ts,
// llm-router.test.ts); this test is the seam between them, driven by a profile
// name exactly as start.ts wires it. The endpoint is a stubbed fetch, so no real
// API key or network is involved.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRoutedLLM } from '../../../src/core/llm-router.js';
import type { ChatChunk, LLM, ToolSchema } from '../../../src/core/llm.js';
import type { Host } from '../../../src/core/modules.js';
import { open } from '../../../src/storage/db.js';
import { createOpenAICompatibleProvider } from './provider.js';
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

// The profile a user puts into Power Mode: models.chat = '<alias>:<model>'. The
// router resolves the profile name to this string, sees the 'deepseek:' prefix,
// and dispatches to the registered provider instead of the base Ollama LLM.
const POWER_MODE_MODEL = 'deepseek:deepseek-chat';

function sse(...payloads: Array<Record<string, unknown> | '[DONE]'>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const body = payloads
    .map((p) => (p === '[DONE]' ? 'data: [DONE]\n\n' : `data: ${JSON.stringify(p)}\n\n`))
    .join('');
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  });
}

function freshHost(): Host & { cleanup: () => void } {
  const tmp = mkdtempSync(join(tmpdir(), 'oai-power-mode-'));
  const db = open({ path: join(tmp, 'g.db') });
  db.exec(migrationSql);
  const values = new Map<string, string>([['secret_openai-compatible_deepseek', 'sk-test']]);
  return {
    db,
    settings: {
      get<T>(key: string, fallback?: T): T {
        return (values.get(key) ?? fallback) as T;
      },
      set(key: string, value: string | number | boolean): void {
        values.set(key, String(value));
      },
      all: (): Record<string, string | number | boolean> => Object.fromEntries(values),
    },
    cleanup() {
      db.close();
      rmSync(tmp, { recursive: true, force: true });
    },
  } as unknown as Host & { cleanup: () => void };
}

// A base Ollama LLM whose `chat` is the smoking gun: if Power Mode routing works,
// it is NEVER called for the Power-Mode profile. resolveModel maps the profile
// NAME 'chat' to the provider alias, exactly as profilesForTier would once a user
// sets models.chat to the alias.
function baseWithPowerModeProfile(onChat: () => void): LLM {
  return {
    chat: () => {
      onChat();
      throw new Error('base.chat must not run for a Power-Mode profile');
    },
    health: async () => ({ ok: true, models: ['qwen3.5:0.8b'] }),
    listProfiles: () => ({ chat: null, reason: null, tools: null }),
    resolveModel: (p) => (typeof p === 'object' ? p.model : POWER_MODE_MODEL),
    breakerSnapshot: () => ({
      state: 'closed',
      failures: 0,
      consecutiveSuccesses: 0,
      openedAt: null,
      retryAt: null,
    }),
    stopIdleEviction: () => {},
  };
}

async function collect(stream: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const c of stream) out.push(c);
  return out;
}

test('Power Mode: a profile pointed at the alias streams from the OpenAI-compatible endpoint', async () => {
  const host = freshHost();
  try {
    let sawAuth: string | null = null;
    const fetchImpl: typeof fetch = async (_url, init) => {
      sawAuth = (init?.headers as Record<string, string>)?.['authorization'] ?? null;
      return new Response(
        sse(
          { choices: [{ delta: { content: 'Hello' } }] },
          {
            choices: [{ delta: { content: ', world' } }],
            usage: { prompt_tokens: 9, completion_tokens: 3 },
          },
          '[DONE]',
        ),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    };
    const provider = createOpenAICompatibleProvider(host, endpoint, settings, { fetchImpl });

    let baseChatCalled = false;
    const routed = createRoutedLLM(baseWithPowerModeProfile(() => (baseChatCalled = true)));
    routed.registerProvider(provider);

    // Drive it by PROFILE NAME — the whole point of Power Mode.
    const chunks = await collect(
      routed.chat({ profile: 'chat', messages: [{ role: 'user', content: 'hi' }] }),
    );

    assert.equal(baseChatCalled, false, 'must route to the provider, not the base Ollama LLM');
    assert.equal(sawAuth, 'Bearer sk-test', 'provider sent the endpoint API key');
    const text = chunks.map((c) => c.delta).join('');
    assert.equal(text, 'Hello, world');
    const done = chunks.at(-1);
    assert.equal(done?.done, true);
    assert.equal(done?.model, 'deepseek:deepseek-chat');
    assert.equal(done?.promptTokens, 9);
    assert.equal(done?.completionTokens, 3);
  } finally {
    host.cleanup();
  }
});

test('Power Mode: tool calls survive the profile→router→provider path', async () => {
  const host = freshHost();
  try {
    let sentTools: unknown;
    const fetchImpl: typeof fetch = async (_url, init) => {
      sentTools = (JSON.parse(String(init?.body)) as { tools?: unknown[] }).tools;
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
                      function: { name: 'lookup_weather', arguments: '{"city":"Toronto"}' },
                    },
                  ],
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
    const routed = createRoutedLLM(baseWithPowerModeProfile(() => {}));
    routed.registerProvider(provider);

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
    const chunks = await collect(
      routed.chat({ profile: 'chat', messages: [{ role: 'user', content: 'weather?' }], tools }),
    );

    assert.ok(sentTools, 'tools reached the endpoint request body');
    const done = chunks.at(-1);
    assert.deepEqual(done?.toolCalls, [
      { id: 'call_1', name: 'lookup_weather', arguments: { city: 'Toronto' } },
    ]);
  } finally {
    host.cleanup();
  }
});

test('Power Mode off: a profile on a plain Ollama tag still uses the base LLM', async () => {
  const host = freshHost();
  try {
    const provider = createOpenAICompatibleProvider(host, endpoint, settings, {
      fetchImpl: async () => {
        throw new Error('provider must not be called for a non-alias model');
      },
    });
    let baseCalled = false;
    // resolveModel returns a plain Ollama tag here, so routing must fall to base.
    const base: LLM = {
      ...baseWithPowerModeProfile(() => {}),
      resolveModel: (p) => (typeof p === 'object' ? p.model : 'qwen3.5:0.8b'),
      chat: async function* () {
        baseCalled = true;
        yield { delta: 'local', done: true, model: 'qwen3.5:0.8b' };
      },
    };
    const routed = createRoutedLLM(base);
    routed.registerProvider(provider);

    const chunks = await collect(
      routed.chat({ profile: 'chat', messages: [{ role: 'user', content: 'hi' }] }),
    );
    assert.equal(baseCalled, true, 'non-alias profile stays on local Ollama');
    assert.equal(chunks.at(-1)?.model, 'qwen3.5:0.8b');
  } finally {
    host.cleanup();
  }
});
