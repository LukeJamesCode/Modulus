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
import {
  setupMemory,
  ftsQueryFromText,
  REMEMBER_TOOL_NAME,
  FORGET_TOOL_NAME,
} from './memory.js';
import { createToolRegistry } from './tools.js';
import { open as openDb } from '../storage/db.js';
import { createLogger } from '../util/log.js';
import type { ToolCall } from './llm.js';

const log = createLogger({ level: 'error', out: () => {}, err: () => {} });

function fresh(opts: { maxRows?: number; confirm?: boolean } = {}): {
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
  const store = setupMemory({ db, tools, log, ...(opts.maxRows ? { maxRows: opts.maxRows } : {}) });
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
    const a = store.remember({ content: 'Coffee order: flat white', source: 'user', importance: 3 });
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
