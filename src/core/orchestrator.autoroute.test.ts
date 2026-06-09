// Tests for deterministic tool auto-routing: a tool's `autoRoute` hook can
// claim a turn so escalation doesn't depend on the model choosing to call it.
// The forced call still flows through execute() — confirm tier + selfReplying.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../storage/db.js';
import { createOrchestrator, type ReplyChunk } from './orchestrator.js';
import { createToolRegistry } from './tools.js';
import { createLogger } from '../util/log.js';
import type { LLM, ChatChunk, ChatOptions } from './llm.js';

function silentLogger() {
  return createLogger({ level: 'error', out: () => {}, err: () => {} });
}

function tmp() {
  return mkdtempSync(join(tmpdir(), 'modulus-orch-autoroute-'));
}

function fakeLlm(scripts: Array<AsyncIterable<ChatChunk>>): LLM & { calls: ChatOptions[] } {
  const calls: ChatOptions[] = [];
  let i = 0;
  const llm: LLM = {
    chat(opts) {
      calls.push(opts);
      const next = scripts[i++];
      if (!next) throw new Error('llm script exhausted (model was called unexpectedly)');
      return next;
    },
    async health() {
      return { ok: true, models: ['fake'] };
    },
    listProfiles() {
      return {
        chat: { model: 'fake', contextTokens: 4096, heavy: false },
        reason: null,
        tools: null,
      };
    },
    resolveModel() {
      return 'fake';
    },
    breakerSnapshot: () => ({
      state: 'closed',
      failures: 0,
      consecutiveSuccesses: 0,
      openedAt: null,
      retryAt: null,
    }),
    stopIdleEviction: () => {},
  };
  return Object.assign(llm, { calls });
}

async function* stream(parts: string[]): AsyncIterable<ChatChunk> {
  for (let i = 0; i < parts.length; i++) {
    const last = i === parts.length - 1;
    yield {
      delta: parts[i]!,
      done: last,
      ...(last ? { promptTokens: 5, completionTokens: parts.length, model: 'fake' } : {}),
    };
  }
}

test('autoRoute forces a selfReplying tool and skips the model entirely', async () => {
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    // No scripts: if the model is called, fakeLlm throws.
    const llm = fakeLlm([]);
    const tools = createToolRegistry({ log: silentLogger(), confirm: async () => true });
    tools.register({
      name: 'forced_tool',
      description: 'forced',
      parameters: { type: 'object', properties: { task: { type: 'string' } } },
      tier: 'confirm',
      selfReplying: true,
      autoRoute: (msg) => (msg.includes('ESCALATE') ? { task: msg } : null),
      invoke: async (args) => `forced answer for: ${(args as { task: string }).task}`,
    });
    const orch = createOrchestrator({ db, llm, tools, log: silentLogger() });

    const chunks: ReplyChunk[] = [];
    await orch.handleUserMessage({
      chatId: 1,
      userId: 1,
      text: 'please ESCALATE this big task',
      send: async (c) => {
        chunks.push(c);
      },
    });

    const reply = chunks
      .map((c) => c.delta)
      .join('')
      .trim();
    assert.match(reply, /forced answer for: please ESCALATE this big task/);
    assert.equal(llm.calls.length, 0, 'model must not be called when auto-routed');
    await orch.shutdown();
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('autoRoute declines (returns null) → normal model turn', async () => {
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    const llm = fakeLlm([stream(['normal ', 'reply'])]);
    const tools = createToolRegistry({ log: silentLogger(), confirm: async () => true });
    tools.register({
      name: 'forced_tool',
      description: 'forced',
      parameters: { type: 'object', properties: { task: { type: 'string' } } },
      tier: 'confirm',
      selfReplying: true,
      autoRoute: (msg) => (msg.includes('ESCALATE') ? { task: msg } : null),
      invoke: async () => 'should not run',
    });
    const orch = createOrchestrator({ db, llm, tools, log: silentLogger() });

    const chunks: ReplyChunk[] = [];
    await orch.handleUserMessage({
      chatId: 2,
      userId: 1,
      text: 'just a normal question',
      send: async (c) => {
        chunks.push(c);
      },
    });

    assert.equal(chunks.map((c) => c.delta).join(''), 'normal reply');
    assert.equal(llm.calls.length, 1, 'model should handle the non-routed turn');
    await orch.shutdown();
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('autoRouteEnabled:false suppresses auto-route → model handles the turn', async () => {
  // Agent runs disable deterministic auto-route so a global tool (e.g. codex on
  // the word "research") can't hijack an explicitly configured persona's turn.
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    const llm = fakeLlm([stream(['agent ', 'reply'])]);
    const tools = createToolRegistry({ log: silentLogger(), confirm: async () => true });
    tools.register({
      name: 'forced_tool',
      description: 'forced',
      parameters: { type: 'object', properties: { task: { type: 'string' } } },
      tier: 'confirm',
      selfReplying: true,
      autoRoute: (msg) => (msg.includes('ESCALATE') ? { task: msg } : null),
      invoke: async () => 'should not run (auto-route disabled)',
    });
    const orch = createOrchestrator({
      db,
      llm,
      tools,
      log: silentLogger(),
      autoRouteEnabled: false,
    });

    const chunks: ReplyChunk[] = [];
    await orch.handleUserMessage({
      chatId: 4,
      userId: 1,
      text: 'please ESCALATE this big task',
      send: async (c) => {
        chunks.push(c);
      },
    });

    assert.equal(chunks.map((c) => c.delta).join(''), 'agent reply');
    assert.equal(llm.calls.length, 1, 'model must handle the turn when auto-route is disabled');
    await orch.shutdown();
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('declining the confirm on a forced call falls back to the model', async () => {
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    // One script for the fallback paraphrase round after the tool is denied.
    const llm = fakeLlm([stream(['fallback answer'])]);
    const tools = createToolRegistry({ log: silentLogger(), confirm: async () => false });
    tools.register({
      name: 'forced_tool',
      description: 'forced',
      parameters: { type: 'object', properties: { task: { type: 'string' } } },
      tier: 'confirm',
      selfReplying: true,
      autoRoute: (msg) => (msg.includes('ESCALATE') ? { task: msg } : null),
      invoke: async () => 'should not run (declined)',
    });
    const orch = createOrchestrator({ db, llm, tools, log: silentLogger() });

    const chunks: ReplyChunk[] = [];
    await orch.handleUserMessage({
      chatId: 3,
      userId: 1,
      text: 'please ESCALATE this',
      send: async (c) => {
        chunks.push(c);
      },
    });

    assert.match(chunks.map((c) => c.delta).join(''), /fallback answer/);
    assert.equal(llm.calls.length, 1, 'declined forced call should fall back to the model');
    await orch.shutdown();
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
