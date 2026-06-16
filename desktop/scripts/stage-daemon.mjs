// Build the daemon payload the installer ships as <install>/daemon:
//
//   staging/daemon/app/   dist/ + modules/ + production node_modules
//   staging/daemon/node/  portable Node runtime (node.exe + npm)
//
// Nothing native ever compiles here: npm ci runs with --ignore-scripts (so
// better-sqlite3 never invokes node-gyp) and the proven prebuilt
// better_sqlite3.node is copied from the repo's node_modules. The repo's own
// node_modules is never modified (see CLAUDE.md — it must never be reinstalled).
//
// Usage: node stage-daemon.mjs   (run from anywhere; paths are script-relative)

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const stagingApp = join(here, '..', 'staging', 'daemon', 'app');
const stagingNode = join(here, '..', 'staging', 'daemon', 'node');

function run(cmd, args, cwd) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) throw new Error(`${cmd} failed with code ${r.status}`);
}

console.log('1/6 building repo dist/ …');
run('npm', ['run', 'build'], repoRoot);

console.log('2/6 copying app payload …');
rmSync(stagingApp, { recursive: true, force: true });
mkdirSync(stagingApp, { recursive: true });
cpSync(join(repoRoot, 'dist'), join(stagingApp, 'dist'), { recursive: true });
// Module entrypoints are tsx-imported at runtime, so ship sources minus tests.
cpSync(join(repoRoot, 'modules'), join(stagingApp, 'modules'), {
  recursive: true,
  filter: (src) => !src.endsWith('.test.ts'),
});
// First-party skills sit beside modules at the app root (defaultSkillRoots
// resolves them relative to dist/, i.e. app/skills). Pure data — no tests live
// inside a bundle, so copy as-is.
if (existsSync(join(repoRoot, 'skills'))) {
  cpSync(join(repoRoot, 'skills'), join(stagingApp, 'skills'), { recursive: true });
}
cpSync(join(repoRoot, 'package.json'), join(stagingApp, 'package.json'));
cpSync(join(repoRoot, 'package-lock.json'), join(stagingApp, 'package-lock.json'));

console.log('3/6 installing production deps (scripts disabled — nothing compiles) …');
run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], stagingApp);

// esbuild's binary ships as a plain optional-dependency package (not a
// postinstall script), so it must have landed despite --ignore-scripts.
const esbuildBin = join(stagingApp, 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe');
if (!existsSync(esbuildBin)) {
  throw new Error('@esbuild/win32-x64 missing from staged node_modules — tsx cannot work');
}

console.log('4/6 copying the proven better-sqlite3 binary …');
const sqliteSrc = join(repoRoot, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
if (!existsSync(sqliteSrc)) throw new Error(`missing ${sqliteSrc} — see CLAUDE.md`);
const sqliteDest = join(stagingApp, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
mkdirSync(dirname(sqliteDest), { recursive: true });
cpSync(sqliteSrc, sqliteDest);

console.log('5/6 fetching portable Node runtime …');
execFileSync(process.execPath, [join(here, 'fetch-node.mjs'), stagingNode], { stdio: 'inherit' });

console.log('6/6 smoke test: staged node.exe + staged better-sqlite3 …');
const smoke = spawnSync(
  join(stagingNode, 'node.exe'),
  ['-e', "const db=require('better-sqlite3')(':memory:');console.log(JSON.stringify(db.prepare('select 1 as x').get()))"],
  { cwd: stagingApp, encoding: 'utf8' },
);
if (smoke.status !== 0 || !smoke.stdout.includes('"x":1')) {
  console.error(smoke.stdout, smoke.stderr);
  throw new Error('smoke test failed — staged runtime cannot load better-sqlite3');
}
console.log(`smoke ok: ${smoke.stdout.trim()}`);

console.log('staging complete: desktop/staging/daemon');
