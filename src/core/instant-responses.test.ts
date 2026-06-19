import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createInstantResponder } from './instant-responses.js';

// A fixed reference moment so the deterministic (date/time) branch is testable
// without depending on the wall clock. 2026-06-10 is a Wednesday, 14:00 local.
const WED_2PM = new Date(2026, 5, 10, 14, 0, 0);

test('deterministic day/date questions bypass the model with a computed answer', () => {
  const r = createInstantResponder();
  // The whole point of the deterministic branch: the small model gets these
  // wrong, so they must be a terminal reply (skip the orchestrator), not an ack.
  const day = r.respond('what day is it?', 1, WED_2PM);
  assert.equal(day?.mode, 'reply');
  assert.equal(day?.text, WED_2PM.toLocaleDateString('en-US', { weekday: 'long' }));

  const tomorrow = r.respond('what day is tomorrow', 1, WED_2PM);
  assert.equal(tomorrow?.mode, 'reply');
  assert.equal(tomorrow?.text, 'Thursday');
});

test('the model-name question answers from the live config, never a stale guess', () => {
  // With a resolver wired, the reply names the actual configured model tag.
  const r = createInstantResponder({ modelName: () => 'llama3.2:3b' });
  const ans = r.respond('what model are you running?', 1, WED_2PM);
  assert.equal(ans?.mode, 'reply');
  assert.match(ans?.text ?? '', /llama3\.2:3b/);
  // No hardcoded family name that goes stale, and never the old project name.
  assert.doesNotMatch(ans?.text ?? '', /qwen/i);
  assert.doesNotMatch(ans?.text ?? '', /Gurney/);
});

test('the model-name question falls back gracefully without a resolver', () => {
  // No resolver (or one that throws): still a deterministic reply pointing at
  // /model rather than letting the small model hallucinate a model name.
  for (const r of [
    createInstantResponder(),
    createInstantResponder({
      modelName: () => {
        throw new Error('not configured');
      },
    }),
  ]) {
    const ans = r.respond('which model are you on', 1, WED_2PM);
    assert.equal(ans?.mode, 'reply');
    assert.match(ans?.text ?? '', /\/model/);
  }
});

test('trivial chatter gets a terminal templated reply (no model turn)', () => {
  const r = createInstantResponder();
  const hi = r.respond('hi', 1, WED_2PM);
  assert.equal(hi?.mode, 'reply');
  assert.ok((hi?.text ?? '').length > 0);
  const thanks = r.respond('thanks!', 1, WED_2PM);
  assert.equal(thanks?.mode, 'reply');
});

test('tool/query intent gets an ack, so the orchestrator still runs after', () => {
  const r = createInstantResponder();
  const query = r.respond("what's the weather today", 1, WED_2PM);
  assert.equal(query?.mode, 'ack');
  const action = r.respond('add milk to my shopping list', 1, WED_2PM);
  assert.equal(action?.mode, 'ack');
});

test('free-form questions and slash commands pass through to the model', () => {
  const r = createInstantResponder();
  assert.equal(r.respond('explain how a transformer attention head works', 1, WED_2PM), null);
  // Slash commands are routed before instant responses; never claim them.
  assert.equal(r.respond('/status', 1, WED_2PM), null);
  assert.equal(r.respond('', 1, WED_2PM), null);
});

test('the same chat does not get the identical variant every time', () => {
  const r = createInstantResponder();
  const seen = new Set<string>();
  for (let i = 0; i < 24; i++) {
    const reply = r.respond('thanks', 7, WED_2PM);
    if (reply) seen.add(reply.text);
  }
  // The "thanks" pool has four variants; over 24 picks with anti-repeat we must
  // see more than one (a fixed single reply would feel canned).
  assert.ok(seen.size > 1, `expected variation, saw ${seen.size} distinct`);
});
