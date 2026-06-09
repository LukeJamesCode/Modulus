import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { humanGap } from './orchestrator.js';

test('humanGap collapses anything under 2 minutes to "just now"', () => {
  // Bucketed coarsely on purpose — finer granularity busts Ollama's prompt
  // cache on every turn because the system prefix changes. Keep this bucket
  // wide enough that consecutive abilitytest turns (a few seconds apart) get
  // the same string back.
  assert.equal(humanGap(0), 'just now');
  assert.equal(humanGap(500), 'just now');
  assert.equal(humanGap(1000), 'just now');
  assert.equal(humanGap(45_000), 'just now');
  assert.equal(humanGap(60_000), 'just now');
  assert.equal(humanGap(119_000), 'just now');
});

test('humanGap returns coarse buckets above 2 minutes', () => {
  assert.equal(humanGap(2 * 60_000), 'a few minutes');
  assert.equal(humanGap(10 * 60_000), 'a few minutes');
  assert.equal(humanGap(15 * 60_000), 'under an hour');
  assert.equal(humanGap(45 * 60_000), 'under an hour');
  assert.equal(humanGap(60 * 60_000), 'about an hour');
  assert.equal(humanGap(3 * 60 * 60_000), '3 hours');
  assert.equal(humanGap(24 * 60 * 60_000), 'a day');
  assert.equal(humanGap(72 * 60 * 60_000), '3 days');
});

test('humanGap handles negative gaps as "just now" (clock skew)', () => {
  // Defensive: if a tool result lands with a slightly-future created_at the
  // model shouldn't see "-2 hours ago".
  assert.equal(humanGap(-5_000), 'just now');
});
