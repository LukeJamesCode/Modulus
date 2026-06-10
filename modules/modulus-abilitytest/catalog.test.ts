// Catalog hygiene. These are the invariants the runner relies on, so a malformed
// new test case fails here instead of erroring mid-run.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { CATALOG } from './catalog.js';

test('every test id is unique', () => {
  const ids = CATALOG.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate test id in the catalog');
});

test('every script ends with a text round (the orchestrator loops until text)', () => {
  for (const t of CATALOG) {
    const last = t.script.at(-1);
    assert.ok(last && 'text' in last, `${t.id}: script must end with a { text } round`);
  }
});

test('every tool a script calls is declared in the test, and vice-versa is checkable', () => {
  for (const t of CATALOG) {
    const declared = new Set((t.tools ?? []).map((s) => s.name));
    for (const round of t.script) {
      if ('tool' in round) {
        assert.ok(
          declared.has(round.tool),
          `${t.id}: script calls undeclared tool '${round.tool}'`,
        );
      }
    }
  }
});

test('expectations reference declared tools', () => {
  for (const t of CATALOG) {
    const declared = new Set((t.tools ?? []).map((s) => s.name));
    for (const name of [...(t.expect.toolsInvoked ?? []), ...(t.expect.toolsNotInvoked ?? [])]) {
      assert.ok(declared.has(name), `${t.id}: expectation references undeclared tool '${name}'`);
    }
  }
});

test('every scorecard dimension is represented', () => {
  const dims = new Set(CATALOG.map((t) => t.dimension));
  for (const d of ['tool-selection', 'delegation', 'e2e', 'chat'] as const) {
    assert.ok(dims.has(d), `catalog has no '${d}' test`);
  }
});
