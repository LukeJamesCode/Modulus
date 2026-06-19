// Hive-mind memory tests. The behaviour that matters (and why):
// - One shared store: a fact remembered in the main chat must be recallable
//   from an agent run's provider — that's the whole hive-mind promise.
// - Eviction must respect importance: a user's importance-3 fact surviving
//   matters more than recency, or the store silently loses what users
//   explicitly asked to keep.
// - forget is confirm-tier: destroying shared state without a human yes would
//   let a prompt-injected agent wipe the hive. It must fail closed.
// - FTS query building must neutralise FTS5 syntax: user text goes into MATCH,
//   and a crash there would take down every turn (recall runs on each one).

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setupMemory, ftsQueryFromText, REMEMBER_TOOL_NAME, FORGET_TOOL_NAME } from './memory.js';
import { createToolRegistry } from './tools.js';
import { open as openDb } from '../storage/db.js';
import { createLogger } from '../util/log.js';
import type { ToolCall } from './llm.js';

const log = createLogger({ level: 'error', out: () => {}, err: () => {} });

function fresh(opts: { maxRows?: number; confirm?: boolean; now?: () => Date } = {}): {
  db: ReturnType<typeof openDb>;
  tools: ReturnType<typeof createToolRegistry>;
  store: ReturnType<typeof setupMemory>;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'modulus-memory-'));
  const db = openDb({ path: join(dir, 'm.db'), log });
  const tools = createToolRegistry({
    log,
    ...(opts.confirm ? { confirm: async () => true } : {}),
  });
  const store = setupMemory({
    db,
    tools,
    log,
    ...(opts.maxRows ? { maxRows: opts.maxRows } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
  return {
    db,
    tools,
    store,
    cleanup: () => {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function call(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `c_${Math.random().toString(36).slice(2, 8)}`, name, arguments: args };
}

test('a fact remembered in the chat is recalled for an agent turn (hive mind)', () => {
  const { store, cleanup } = fresh();
  try {
    // Written via the main chat path…
    store.remember({ content: "Lukas's dog is called Biscuit", source: 'user' });
    // …and recalled by the same provider an agent orchestrator uses.
    const block = store.renderForPrompt('book a vet appointment for biscuit the dog');
    assert.ok(block, 'agent turn should recall the chat-learned fact');
    assert.match(block, /Biscuit/);
    assert.match(block, /shared across all agents/);
  } finally {
    cleanup();
  }
});

test('duplicate content dedups to one row and keeps the higher importance', () => {
  const { store, cleanup } = fresh();
  try {
    const a = store.remember({
      content: 'Coffee order: flat white',
      source: 'user',
      importance: 3,
    });
    const b = store.remember({ content: '  coffee   order: FLAT WHITE ', source: 'extraction' });
    assert.equal(a, b, 'normalised duplicates must collapse to the same row');
    assert.equal(store.count(), 1);
    assert.equal(store.list()[0]!.importance, 3, 'dedup must never downgrade importance');
  } finally {
    cleanup();
  }
});

test('eviction removes low-importance rows first and never an importance-3 over a 1', () => {
  const { store, cleanup } = fresh({ maxRows: 3 });
  try {
    store.remember({ content: 'critical fact alpha', source: 'user', importance: 3 });
    store.remember({ content: 'trivia beta', source: 'extraction', importance: 1 });
    store.remember({ content: 'trivia gamma', source: 'extraction', importance: 1 });
    store.remember({ content: 'trivia delta', source: 'extraction', importance: 1 });
    assert.equal(store.count(), 3, 'cap must hold');
    const contents = store.list().map((r) => r.content);
    assert.ok(
      contents.includes('critical fact alpha'),
      'the importance-3 row must survive while importance-1 rows existed to evict',
    );
  } finally {
    cleanup();
  }
});

test('renderForPrompt returns undefined with nothing relevant and bumps uses on hits', () => {
  const { store, cleanup } = fresh();
  try {
    assert.equal(store.renderForPrompt('anything at all'), undefined);
    store.remember({ content: 'The wifi password is in the kitchen drawer', source: 'user' });
    assert.equal(store.renderForPrompt('zebra quantum xylophone'), undefined);
    const hit = store.renderForPrompt('where is the wifi password');
    assert.ok(hit);
    assert.equal(store.list()[0]!.uses, 1, 'recall must bump usage so eviction favours hot rows');
  } finally {
    cleanup();
  }
});

test('FTS5 syntax in user text cannot crash or steer recall', () => {
  const { store, cleanup } = fresh();
  try {
    store.remember({ content: 'Project deadline is Friday', source: 'user' });
    // Each of these is valid-but-hostile FTS5 syntax if interpolated raw.
    for (const evil of ['NEAR(deadline, 2)', 'content: "x" OR', '"unterminated', 'a AND NOT b*']) {
      assert.doesNotThrow(() => store.recall(evil));
    }
    assert.match(store.renderForPrompt('NEAR( the project deadline')!, /Friday/);
  } finally {
    cleanup();
  }
});

test('ftsQueryFromText quotes tokens and drops stopwords', () => {
  assert.equal(ftsQueryFromText('what is the deadline'), '"deadline"');
  assert.equal(ftsQueryFromText(''), '');
  assert.equal(ftsQueryFromText('the and for'), '');
});

test('ftsQueryFromText keeps 2-char tech terms but drops 2-char function words', () => {
  // The tokenizer now keeps 2-char tokens so AI, JS, Go, OS, UI, DB survive.
  assert.equal(ftsQueryFromText('learn ai and js'), '"learn" OR "ai" OR "js"');
  assert.equal(ftsQueryFromText('go os ui db'), '"go" OR "os" OR "ui" OR "db"');
  // ...but 2-char function words are stopworded out, so noise stays gone.
  assert.equal(ftsQueryFromText('is it on or no'), '');
});

test('remember tool stores with source user; forget tool fails closed unconfirmed', async () => {
  const { tools, store, cleanup } = fresh(); // no confirm hook wired
  try {
    const r = await tools.execute(call(REMEMBER_TOOL_NAME, { content: 'Lukas lives in Alberta' }), {
      log,
    });
    assert.equal(r.ok, true, r.output);
    assert.equal(store.list()[0]!.source, 'user');

    // Unattended context: no confirm hook → the registry must deny, not run.
    const f = await tools.execute(call(FORGET_TOOL_NAME, { query: 'Alberta' }), { log });
    assert.equal(f.ok, false, 'forget without confirmation must fail closed');
    assert.equal(store.count(), 1, 'nothing may be deleted on a denied confirm');
  } finally {
    cleanup();
  }
});

test('forget tool deletes matching rows once confirmed', async () => {
  const { tools, store, cleanup } = fresh({ confirm: true });
  try {
    store.remember({ content: 'Old address: 12 Elm Street', source: 'user' });
    store.remember({ content: 'Favourite colour is green', source: 'user' });
    const f = await tools.execute(call(FORGET_TOOL_NAME, { query: 'elm street address' }), { log });
    assert.equal(f.ok, true, f.output);
    assert.match(f.output, /Forgot 1 memory/);
    assert.equal(store.count(), 1);
    assert.match(store.list()[0]!.content, /green/);
  } finally {
    cleanup();
  }
});

test('promoteFindings tags rows with the learning agent and dedups', () => {
  const { store, cleanup } = fresh();
  try {
    const n = store.promoteFindings(
      ['The API rate limit is 60/min', 'The API rate limit is 60/min', '  '],
      'researcher',
    );
    assert.equal(n, 2, 'blank findings are skipped; duplicates dedup at the store');
    assert.equal(store.count(), 1);
    const row = store.list()[0]!;
    assert.equal(row.source, 'agent:researcher');
    assert.equal(row.importance, 2);
    // The promoted finding is now hive knowledge: any other agent recalls it.
    assert.match(store.renderForPrompt('what is the api rate limit')!, /60\/min/);
  } finally {
    cleanup();
  }
});

test('content is truncated at the cap so a transcript dump cannot bloat the prefix', () => {
  const { store, cleanup } = fresh();
  try {
    store.remember({ content: 'x'.repeat(5000), source: 'user' });
    assert.ok(store.list()[0]!.content.length <= 600);
  } finally {
    cleanup();
  }
});

test('per-agent namespaces: an agent recalls global ∪ its own, never another agent private', () => {
  const { store, cleanup } = fresh();
  try {
    // Global user truth, plus two agents' private findings.
    store.remember({ content: 'User lives in Lisbon', source: 'user' });
    store.promoteFindings(['Agent seven private detail about widgets'], 'alpha', 7);
    store.promoteFindings(['Agent nine private secret about gadgets'], 'beta', 9);

    // Main chat (no agentId): global only — neither agent's private row leaks.
    const chat = store.renderForPrompt('where the user lives plus widgets gadgets')!;
    assert.match(chat, /Lisbon/);
    assert.doesNotMatch(chat, /widgets/);
    assert.doesNotMatch(chat, /gadgets/);

    // Agent 7: global + its own, but not agent 9's namespace.
    const a7 = store.renderForPrompt('lisbon widgets gadgets', 7)!;
    assert.match(a7, /Lisbon/, 'the hive-mind user fact is still recalled in an agent run');
    assert.match(a7, /widgets/, 'its own finding is recalled');
    assert.doesNotMatch(a7, /gadgets/, "another agent's private finding must stay private");
  } finally {
    cleanup();
  }
});

test('recallScoped returns global ∪ one agent, never another agent private', () => {
  const { store, cleanup } = fresh();
  try {
    store.remember({ content: 'User lives in Lisbon', source: 'user' });
    store.promoteFindings(['Agent seven private detail about widgets'], 'alpha', 7);
    store.promoteFindings(['Agent nine private secret about gadgets'], 'beta', 9);

    // Agent-scoped search surfaces the global row too (the browser bug), and
    // keeps another agent's namespace out.
    const a7 = store
      .recallScoped('lisbon widgets gadgets', 7)
      .map((r) => r.content)
      .join(' | ');
    assert.match(a7, /Lisbon/, 'global rows must surface in an agent-scoped search');
    assert.match(a7, /widgets/);
    assert.doesNotMatch(a7, /gadgets/);

    // No agentId → global only.
    const global = store
      .recallScoped('lisbon widgets gadgets', undefined)
      .map((r) => r.content)
      .join(' | ');
    assert.match(global, /Lisbon/);
    assert.doesNotMatch(global, /widgets/);
  } finally {
    cleanup();
  }
});

test('promoteFindings(agentId) scopes the row; forgetAgent drops just that namespace', () => {
  const { store, cleanup } = fresh();
  try {
    store.remember({ content: 'Global fact stays', source: 'user' });
    store.promoteFindings(['Private to seven'], 'alpha', 7);
    store.promoteFindings(['Private to nine'], 'beta', 9);

    assert.equal(store.list(undefined, undefined, 7).length, 1, 'agent 7 owns one row');
    assert.equal(store.list(undefined, undefined, 7)[0]!.agentId, 7);

    const dropped = store.forgetAgent(7);
    assert.equal(dropped, 1);
    assert.equal(store.list(undefined, undefined, 7).length, 0, "7's namespace is gone");
    assert.equal(store.list(undefined, undefined, 9).length, 1, "9's namespace is untouched");
    assert.equal(store.count(), 2, 'global fact + agent 9 survive');
  } finally {
    cleanup();
  }
});

test('consolidate promotes hot rows and decays stale extraction noise, sparing the rest', () => {
  let clock = Date.UTC(2026, 0, 1);
  const { store, cleanup } = fresh({ now: () => new Date(clock) });
  const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
  try {
    // A hot extraction fact that keeps earning recall…
    store.remember({ content: 'frequently needed coffee preference', source: 'extraction' });
    for (let i = 0; i < 5; i++) store.renderForPrompt('frequently needed coffee preference');
    // …a stale extraction fact never recalled…
    store.remember({ content: 'ephemeral trivia nobody asked about', source: 'extraction' });
    // …and two rows that must be immune to decay.
    store.remember({ content: 'durable user note kept forever', source: 'user' });
    store.promoteFindings(['a finding worth importance two'], 'researcher');

    // Jump 40 days so the stale extraction row ages past the cutoff.
    clock += 40 * 24 * 60 * 60 * 1000;
    const res = store.consolidate({ minUses: 5, maxStaleMs: THIRTY_DAYS });

    assert.equal(res.promoted, 1, 'only the hot row crosses the uses threshold');
    assert.equal(res.decayed, 1, 'only the stale uses-0 extraction row is pruned');

    const byContent = new Map(store.list().map((r) => [r.content, r]));
    assert.equal(byContent.get('frequently needed coffee preference')!.importance, 2);
    assert.ok(!byContent.has('ephemeral trivia nobody asked about'), 'stale noise gone');
    assert.ok(byContent.has('durable user note kept forever'), 'user fact immune to decay');
    assert.ok(byContent.has('a finding worth importance two'), 'importance-2 finding immune');
  } finally {
    cleanup();
  }
});
