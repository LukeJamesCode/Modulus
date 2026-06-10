// Pins the report format against the CLI's --fails re-run parser. If renderReport
// and that regex ever drift, `modulus abilitytest --fails` would silently re-run
// the wrong set (or nothing), so this round-trip is the guard.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { renderReport, renderScorecard, summarize, type TestResult } from './report.js';

// The exact regex `modulus abilitytest --fails` uses in src/cli/index.ts to pull
// failed/errored ids out of the latest report. Kept here verbatim — this test
// fails loudly if either side changes without the other.
const CLI_FAILS_RE = /^\|\s+[✗!]\s+(?:fail|error)\s+\|\s+`([^`]+)`/;

const results: TestResult[] = [
  {
    id: 'tool-weather',
    ability: 'weather',
    dimension: 'tool-selection',
    status: 'pass',
    detail: 'ran [get_weather]',
    elapsedMs: 3,
  },
  {
    id: 'delegate-research',
    ability: 'delegation',
    dimension: 'delegation',
    status: 'fail',
    detail: "expected tool 'escalate_to_agent' to run",
    elapsedMs: 4,
  },
  {
    id: 'e2e-add-todo',
    ability: 'tasks',
    dimension: 'e2e',
    status: 'error',
    detail: 'boom',
    elapsedMs: 1,
  },
];

test('the --fails parser extracts exactly the failed and errored ids', () => {
  const md = renderReport(results, 'full');
  const ids: string[] = [];
  for (const line of md.split('\n')) {
    const m = CLI_FAILS_RE.exec(line);
    if (m) ids.push(m[1]!);
  }
  // The passing row must NOT be picked up; the fail and error rows must be.
  assert.deepEqual(ids, ['delegate-research', 'e2e-add-todo']);
});

test('a passing row uses the ✓ pass cell the parser ignores', () => {
  const md = renderReport(results, 'full');
  const passLine = md.split('\n').find((l) => l.includes('`tool-weather`'))!;
  assert.match(passLine, /\| ✓ pass \| `tool-weather` \|/);
  assert.equal(CLI_FAILS_RE.test(passLine), false, 'a pass row must not match the --fails parser');
});

test('summarize counts pass/fail/error', () => {
  assert.deepEqual(summarize(results), { pass: 1, fail: 1, error: 1, total: 3 });
});

test('the scorecard puts one column per profile and a per-dimension pass rate', () => {
  // Two profiles, two dimensions, with the second profile strictly worse on
  // tool-selection — the scorecard exists to make exactly that gap visible at a
  // glance, so the rendered rates must reflect it.
  const local: TestResult[] = [
    {
      id: 'a',
      ability: 'x',
      dimension: 'tool-selection',
      status: 'pass',
      detail: '',
      elapsedMs: 0,
    },
    { id: 'b', ability: 'y', dimension: 'delegation', status: 'pass', detail: '', elapsedMs: 0 },
  ];
  const power: TestResult[] = [
    {
      id: 'a',
      ability: 'x',
      dimension: 'tool-selection',
      status: 'fail',
      detail: '',
      elapsedMs: 0,
    },
    { id: 'b', ability: 'y', dimension: 'delegation', status: 'pass', detail: '', elapsedMs: 0 },
  ];
  const md = renderScorecard([
    { label: 'local:m', results: local },
    { label: 'power:n', results: power },
  ]);
  // Header carries both profile labels as columns.
  assert.match(md, /\| Dimension \| local:m \| power:n \|/);
  // tool-selection: local 1/1, power 0/1 — the regression is legible.
  assert.match(md, /\| tool-selection \| 1\/1 \| 0\/1 \|/);
  // Overall rolls up across dimensions: local 2/2, power 1/2.
  assert.match(md, /\| \*\*Overall\*\* \| \*\*2\/2\*\* \| \*\*1\/2\*\* \|/);
});

test('detail cells with pipes are escaped so the table stays valid', () => {
  const md = renderReport(
    [{ id: 'x', ability: 'a', dimension: 'chat', status: 'fail', detail: 'a | b', elapsedMs: 0 }],
    'smoke',
  );
  const row = md.split('\n').find((l) => l.includes('`x`'))!;
  assert.match(row, /a \\\| b/);
});
