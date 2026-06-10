// Guards the heavy-module dep bootstrap. The contract that matters: enabling a
// heavy module must not report success while one of its import-time deps is
// still missing (that would let a module that can't load look "ready"), and it
// must not reinstall what already resolves (so re-enable is fast and a dep that
// happens to be hoisted to the repo root is a free no-op).

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureNpmDeps,
  npmInstallInvocation,
  readInstalledVersions,
  type NpmDep,
} from './module-npm-deps.js';

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

test('npm install invocation pins exact versions with --save-exact', () => {
  // "Pin exactly" — a reinstall must reproduce the running version, not drift
  // to a newer minor the declared caret would allow.
  const inv = npmInstallInvocation('/fake/module', ['playwright@^1.49.0']);
  assert.ok(
    inv.args.includes('--save-exact'),
    `expected --save-exact in ${JSON.stringify(inv.args)}`,
  );
});

test('readInstalledVersions reads the exact installed version off disk', () => {
  // Stand up a fake module-local node_modules with a real package.json so the
  // default resolver walks it the way the runtime import will.
  const folder = mkdtempSync(join(tmpdir(), 'modulus-deps-'));
  try {
    const pkgDir = join(folder, 'node_modules', 'playwright');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'playwright', version: '1.49.1' }),
    );
    // Declared range is a caret; the recorded version is the exact resolved one.
    const got = readInstalledVersions(folder, [
      { pkg: 'playwright', version: '^1.49.0' },
      { pkg: 'not-installed', version: '^1.0.0' },
    ]);
    assert.deepEqual(
      got,
      { playwright: '1.49.1' },
      'records resolved version, omits the missing dep',
    );
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('npm install invocation quotes a module folder with spaces on win32', () => {
  // A user under `C:\Users\My Name\…` has a space in every module path. The
  // win32 install runs through cmd.exe (npm is npm.cmd), which word-splits on
  // spaces — so the --prefix path must arrive quoted, as a single argument.
  const spaced = 'C:\\Users\\My Name\\.modulus\\modules\\modulus-browser';
  const inv = npmInstallInvocation(spaced, ['playwright@^1.49.0']);
  assert.equal(inv.command, 'npm');
  if (process.platform === 'win32') {
    assert.equal(inv.shell, true);
    assert.ok(
      inv.args.includes(`"${spaced}"`),
      `spaced --prefix path must be quoted; got ${JSON.stringify(inv.args)}`,
    );
    // The prefix flag and the (space-free) package spec stay unquoted.
    assert.ok(inv.args.includes('--prefix'));
    assert.ok(inv.args.includes('playwright@^1.49.0'));
  } else {
    // POSIX runs without a shell: no quoting, the path is one argv entry.
    assert.equal(inv.shell, false);
    assert.ok(inv.args.includes(spaced));
  }
});
