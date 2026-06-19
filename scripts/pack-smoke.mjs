#!/usr/bin/env node
// Smoke-test the PUBLISHED artifact, not the repo: pack the tarball, install it
// into a throwaway project, and prove it boots from dist/ with its native
// dependency loading. This is the real "does `npx modulus-agent` work on this
// platform/Node?" check — run it in CI across the {linux, win, mac} × {Node 20,22}
// matrix (mac is arm64, so it also covers darwin-arm64 prebuilds). Runs locally
// too, wherever the toolchain/network can install better-sqlite3.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', ...opts });
}

console.log('1/4  build (ship a fresh dist/, what prepublishOnly does)…');
run(npm, ['run', 'build'], { cwd: repoRoot, stdio: 'inherit' });

console.log('2/4  npm pack…');
const packed = JSON.parse(run(npm, ['pack', '--json'], { cwd: repoRoot }));
const tarball = join(repoRoot, packed[0].filename);

const dir = mkdtempSync(join(tmpdir(), 'modulus-packsmoke-'));
let ok = false;
try {
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'modulus-packsmoke', version: '0.0.0', private: true }),
  );

  console.log('3/4  install the tarball into a clean project (resolves real deps)…');
  run(npm, ['install', '--no-audit', '--no-fund', tarball], { cwd: dir, stdio: 'inherit' });

  console.log('4/4  boot the published CLI…');
  const bin = join(dir, 'node_modules', pkg.name, 'dist', 'cli', 'index.js');
  const version = run(process.execPath, [bin, '--version'], { cwd: dir }).trim();
  if (!version.includes(pkg.version)) {
    throw new Error(`--version printed "${version}", expected to include ${pkg.version}`);
  }
  console.log(`     ${pkg.name} --version → ${version}`);

  // The real matrix check: the native better-sqlite3 binary must load on THIS
  // platform/Node. A passing --version alone wouldn't prove it (it never touches
  // the DB), so load the addon directly from the installed tree.
  run(process.execPath, ['-e', "new (require('better-sqlite3'))(':memory:').close()"], {
    cwd: dir,
  });
  console.log('     better-sqlite3 native binary loaded OK');

  ok = true;
  console.log('\nPACK SMOKE PASSED');
} finally {
  rmSync(dir, { recursive: true, force: true });
  rmSync(tarball, { force: true });
}
if (!ok) process.exit(1);
