// Discover *.test.ts files under src/ and run them through Node's built-in
// test runner with tsx loader. Node 20's --test does not glob .ts files for
// us, so we walk the tree ourselves.

import { spawn } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

function findTests(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      out.push(...findTests(p));
    } else if (entry.endsWith('.test.ts')) {
      out.push(p);
    }
  }
  return out;
}

const tests = [...findTests('src'), ...findTests('extensions')];
if (tests.length === 0) {
  console.log('No test files found.');
  process.exit(0);
}

// Resolve tsx to an absolute file URL relative to this script so the
// --import flag works regardless of cwd or how the npm script is invoked.
// Passing the bare specifier "tsx" relies on Node's runtime resolution from
// cwd, which fails with ERR_MODULE_NOT_FOUND in some environments.
const require = createRequire(import.meta.url);
const tsxLoader = pathToFileURL(require.resolve('tsx')).href;

const child = spawn(
  process.execPath,
  ['--import', tsxLoader, '--test', '--test-reporter=spec', ...tests],
  { stdio: 'inherit' },
);
child.on('exit', (code) => process.exit(code ?? 0));
