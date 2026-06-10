// Guards the heavy-module dep bootstrap. The contract that matters: enabling a
// heavy module must not report success while one of its import-time deps is
// still missing (that would let a module that can't load look "ready"), and it
// must not reinstall what already resolves (so re-enable is fast and a dep that
// happens to be hoisted to the repo root is a free no-op).

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { ensureNpmDeps, type NpmDep } from './module-npm-deps.js';

const DEPS: NpmDep[] = [
  { pkg: 'playwright', version: '^1.49.0' },
  { pkg: '@discordjs/voice', version: '^0.18.0' },
];

// Build options whose `isResolvable` reads a live set, so a fake install can
// "install" packages by adding them to it. Captures stdout + the install specs.
function harness(present: Set<string>, installOutcome: 'adds' | 'fails' | 'noop') {
  const out: string[] = [];
  const installs: string[][] = [];
  return {
    out,
    installs,
    opts: {
      folder: '/fake/module',
      stdout: (t: string) => out.push(t),
      isResolvable: (pkg: string) => present.has(pkg),
      runInstall: async (_folder: string, specs: string[]): Promise<number | null> => {
        installs.push(specs);
        if (installOutcome === 'fails') return 1;
        if (installOutcome === 'adds')
          for (const s of specs)
            present.add(s.split('@').slice(0, -1).join('@') || s.split('@')[0]!);
        return 0;
      },
    },
  };
}

test('skips the install entirely when every dep already resolves', async () => {
  const present = new Set(['playwright', '@discordjs/voice']);
  const h = harness(present, 'noop');
  const ok = await ensureNpmDeps(DEPS, h.opts);
  assert.equal(ok, true);
  assert.equal(h.installs.length, 0, 'must not shell out to npm when nothing is missing');
});

test('installs only the missing deps, with the pinned version specs', async () => {
  // playwright present (e.g. left from a prior enable); only the voice dep missing.
  const present = new Set(['playwright']);
  const h = harness(present, 'adds');
  const ok = await ensureNpmDeps(DEPS, h.opts);
  assert.equal(ok, true);
  assert.deepEqual(h.installs, [['@discordjs/voice@^0.18.0']], 'installs exactly the missing spec');
});

test('reports failure (not success) when npm install exits non-zero', async () => {
  const present = new Set<string>();
  const h = harness(present, 'fails');
  const ok = await ensureNpmDeps(DEPS, h.opts);
  assert.equal(ok, false, 'a failed install must not be reported as ready');
  assert.ok(
    h.out.some((l) => l.includes('npm install failed')),
    'surfaces the failure on stdout',
  );
});

test('reports failure when install exits clean but a dep still will not resolve', async () => {
  // The dangerous case: npm "succeeds" but the package still cannot be imported.
  // Enabling must not claim the module is ready, or it will crash-loop on load.
  const present = new Set<string>();
  const h = harness(present, 'noop'); // exits 0 but adds nothing to `present`
  const ok = await ensureNpmDeps(DEPS, h.opts);
  assert.equal(ok, false);
  assert.ok(
    h.out.some((l) => l.includes("still won't resolve")),
    'names the dep that did not land',
  );
});
