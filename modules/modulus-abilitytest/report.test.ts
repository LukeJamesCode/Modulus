// Pins the report format against the CLI's --fails re-run parser. If renderReport
// and that regex ever drift, `modulus abilitytest --fails` would silently re-run
// the wrong set (or nothing), so this round-trip is the guard.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { renderReport, summarize, type TestResult } from './report.js';

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

test('detail cells with pipes are escaped so the table stays valid', () => {
  const md = renderReport(
    [{ id: 'x', ability: 'a', dimension: 'chat', status: 'fail', detail: 'a | b', elapsedMs: 0 }],
    'smoke',
  );
  const row = md.split('\n').find((l) => l.includes('`x`'))!;
  assert.match(row, /a \\\| b/);
});
