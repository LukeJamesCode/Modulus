// Download + SHA256-verify a portable Node runtime for the daemon payload.
// Pinned to the same major as the dev box so the proven better-sqlite3 binary
// (ABI 115 = Node 20.x) can be reused verbatim — nothing ever compiles.
//
// Usage: node fetch-node.mjs [destDir]   (default: ../staging/daemon/node)

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, renameSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const NODE_VERSION = '20.20.0';
const DIST = `node-v${NODE_VERSION}-win-x64`;
const BASE = `https://nodejs.org/dist/v${NODE_VERSION}`;

const here = dirname(fileURLToPath(import.meta.url));
const cacheDir = join(here, '..', '.cache');
const dest = resolve(process.argv[2] ?? join(here, '..', 'staging', 'daemon', 'node'));

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed ${res.status}: ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  mkdirSync(cacheDir, { recursive: true });
  const zipPath = join(cacheDir, `${DIST}.zip`);

  if (!existsSync(zipPath)) {
    console.log(`downloading ${BASE}/${DIST}.zip …`);
    const zip = await download(`${BASE}/${DIST}.zip`);
    writeFileSync(zipPath, zip);
  } else {
    console.log(`using cached ${zipPath}`);
  }

  console.log('verifying SHASUMS256 …');
  const shasums = (await download(`${BASE}/SHASUMS256.txt`)).toString('utf8');
  const line = shasums.split('\n').find((l) => l.trim().endsWith(`${DIST}.zip`));
  if (!line) throw new Error(`no SHASUMS256 entry for ${DIST}.zip`);
  const expected = line.trim().split(/\s+/)[0];
  const actual = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
  if (actual !== expected) {
    rmSync(zipPath);
    throw new Error(`sha256 mismatch for ${DIST}.zip (got ${actual}, want ${expected}) — cache cleared, retry`);
  }

  console.log(`extracting to ${dest} …`);
  rmSync(dest, { recursive: true, force: true });
  const extractRoot = join(cacheDir, 'extract');
  rmSync(extractRoot, { recursive: true, force: true });
  mkdirSync(extractRoot, { recursive: true });
  // Windows 10+ ships bsdtar, which extracts zips; avoids an unzip dependency.
  const tar = spawnSync('tar', ['-xf', zipPath, '-C', extractRoot], { stdio: 'inherit' });
  if (tar.status !== 0) throw new Error('tar extraction failed');

  mkdirSync(dirname(dest), { recursive: true });
  renameSync(join(extractRoot, DIST), dest);
  rmSync(extractRoot, { recursive: true, force: true });

  if (!existsSync(join(dest, 'node.exe'))) throw new Error('node.exe missing after extract');
  if (!existsSync(join(dest, 'npm.cmd'))) throw new Error('npm.cmd missing after extract');
  console.log(`ok: ${dest} (${readdirSync(dest).length} entries)`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
