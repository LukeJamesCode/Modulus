import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../storage/db.js';
import { createAgentRegistry } from './agents.js';
import { chooseAgentForTask } from './agent-router.js';
import { createLogger } from '../util/log.js';
import type { LLM, ChatChunk, ChatOptions } from './llm.js';

const log = createLogger({ level: 'error', out: () => {}, err: () => {} });

function tmp() {
  return mkdtempSync(join(tmpdir(), 'modulus-router-'));
}

// FakeLLM that replies with a fixed string for the one classification call.
// `calls` lets a test assert the model was (or wasn't) consulted.
function fakeLlm(reply: string): LLM & { calls: ChatOptions[] } {
  const calls: ChatOptions[] = [];
  async function* one(): AsyncIterable<ChatChunk> {
    yield { delta: reply, done: true, model: 'fake' };
  }
  const llm: LLM = {
    chat(opts) {
      calls.push(opts);
      return one();
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
    resolveModel: () => 'fake',
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

test('rules pick an obvious match without calling the model', async () => {
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    const reg = createAgentRegistry(db);
    reg.create({
      name: 'researcher',
      role: 'Looks things up and reports the facts',
      systemPrompt: 'x',
      profile: 'tools',
    });
    reg.create({ name: 'writer', role: 'Drafts clear prose', systemPrompt: 'x', profile: 'chat' });
    const llm = fakeLlm('NONE');

    const choice = await chooseAgentForTask({
      task: 'research the best mini-PCs for a home server',
      agents: reg.list(),
      llm,
      log,
    });
    assert.ok(choice);
    assert.equal(choice.agentName, 'researcher');
    assert.equal(choice.via, 'rule');
    assert.equal(llm.calls.length, 0, 'rules pass must not call the model');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an ambiguous task falls through to the model', async () => {
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    const reg = createAgentRegistry(db);
    // Two personas that both score on "research" — a tie the rules can't break.
    reg.create({ name: 'scout', role: 'researches topics on the web', systemPrompt: 'x' });
    reg.create({ name: 'digger', role: 'researches and digs up facts', systemPrompt: 'x' });
    const llm = fakeLlm('scout');

    const choice = await chooseAgentForTask({
      task: 'research quantum computing trends',
      agents: reg.list(),
      llm,
      log,
    });
    assert.ok(choice);
    assert.equal(choice.agentName, 'scout');
    assert.equal(choice.via, 'model');
    assert.equal(llm.calls.length, 1, 'the tie must escalate to the model');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('model NONE → null (no specialist fits)', async () => {
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    const reg = createAgentRegistry(db);
    reg.create({ name: 'scout', role: 'researches topics', systemPrompt: 'x' });
    reg.create({ name: 'digger', role: 'researches facts', systemPrompt: 'x' });
    const llm = fakeLlm('NONE');

    const choice = await chooseAgentForTask({
      task: 'research something tricky and undecidable',
      agents: reg.list(),
      llm,
      log,
    });
    assert.equal(choice, null);
    assert.equal(llm.calls.length, 1);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unparseable model reply → null', async () => {
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    const reg = createAgentRegistry(db);
    reg.create({ name: 'scout', role: 'researches topics', systemPrompt: 'x' });
    reg.create({ name: 'digger', role: 'researches facts', systemPrompt: 'x' });
    const llm = fakeLlm('I think maybe the blue one?');

    const choice = await chooseAgentForTask({
      task: 'research something tricky',
      agents: reg.list(),
      llm,
      log,
    });
    assert.equal(choice, null);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('empty fleet → null, with no model call', async () => {
  const llm = fakeLlm('whatever');
  const choice = await chooseAgentForTask({ task: 'do a thing', agents: [], llm, log });
  assert.equal(choice, null);
  assert.equal(llm.calls.length, 0);
});
