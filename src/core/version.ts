// Single source of truth for the core/host version string.
//
// Every place that needs the host version — the panel's /api/state report and
// the registry `minCoreVersion` gate (marketplace + `modulus mod`) — imports
// HOST_VERSION from here, so they can never drift apart. The value is read once
// from the repo's package.json (npm's own version field), so bumping the
// release version in one place updates everything.
//
// Path note: package.json sits at the repo root, next to dist/. rootDir is src/
// and outDir is dist/, so this file lands at dist/core/version.js; `../../`
// resolves to the repo root from both the compiled layout and tsx-run src/.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function readHostVersion(): string {
  const pkgUrl = new URL('../../package.json', import.meta.url);
  const pkg = JSON.parse(readFileSync(fileURLToPath(pkgUrl), 'utf8')) as { version?: unknown };
  if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
    throw new Error('package.json has no usable "version" field');
  }
  return pkg.version;
}

export const HOST_VERSION: string = readHostVersion();
