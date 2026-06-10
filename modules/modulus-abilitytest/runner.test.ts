// The deterministic ability-test subset, run in CI. This is the regression gate
// the handoff calls for: if a change to the orchestrator's tool-dispatch loop,
// the escalation routing, or the reply path breaks the agent pipeline, a smoke
// ability test flips to fail here — without needing Ollama or a network.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { runCatalog } from './runner.js';
import { CATALOG, type AbilityTest } from './catalog.js';

test('smoke tier: every deterministic ability test passes against the real orchestrator', async () => {
  const results = await runCatalog({ tier: 'smoke' });
  assert.ok(results.length > 0, 'smoke tier must select at least one test');
  const bad = results.filter((r) => r.status !== 'pass');
  assert.deepEqual(
    bad.map((r) => `${r.id}: ${r.status} (${r.detail})`),
    [],
    'all smoke ability tests must pass',
  );
});

test('full tier runs every catalog entry and all pass', async () => {
  const results = await runCatalog({ tier: 'full' });
  assert.equal(results.length, CATALOG.length, 'full tier runs the whole catalog');
  assert.equal(
    results.filter((r) => r.status === 'pass').length,
    CATALOG.length,
    'every catalog test passes',
  );
});

test('tiers are cumulative: smoke ⊆ standard ⊆ full', async () => {
  const smoke = await runCatalog({ tier: 'smoke' });
  const standard = await runCatalog({ tier: 'standard' });
  const full = await runCatalog({ tier: 'full' });
  assert.ok(smoke.length <= standard.length, 'standard includes everything smoke does');
  assert.ok(standard.length <= full.length, 'full includes everything standard does');
});

test('filter narrows the selection by id or ability', async () => {
  const results = await runCatalog({ tier: 'full', filter: '^delegate-research$' });
  assert.equal(results.length, 1);
  assert.equal(results[0]!.id, 'delegate-research');
});

test('a broken expectation is reported as fail, not a false pass', async () => {
  // Inject a deliberately wrong test: the model never calls the tool, but the
  // expectation demands it. The judge must catch this — proving the harness can
  // actually fail (Rule 9: a test that cannot fail is worthless).
  const broken: AbilityTest = {
    id: 'self-check-fail',
    ability: 'meta',
    tier: 'full',
    dimension: 'tool-selection',
    message: 'do nothing',
    tools: [{ name: 'never_called', description: 'x' }],
    script: [{ text: 'I did not call the tool.' }],
    expect: { toolsInvoked: ['never_called'] },
  };
  const results = await runCatalog({ tier: 'full', catalog: [broken] });
  assert.equal(results[0]!.status, 'fail');
  assert.match(results[0]!.detail, /never_called/);
});
