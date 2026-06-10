// Shared filesystem layout for installed modules. Both the repo-bundled
// modules (shipped alongside the CLI) and user-installed ones (under
// ~/.modulus/modules) are scanned by several commands (status, doctor,
// config, auth, mod). This module owns the roots and the directory walk so
// those commands don't each re-implement the same readdir/stat skeleton.

import { readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function repoModulesRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', 'modules');
}

export function userModulesRoot(home: string): string {
  return join(home, 'modules');
}

export interface ModuleFolder {
  folder: string;
  source: 'user' | 'repo';
}

// Yield each candidate module directory, user installs first then bundled.
// Unreadable roots and non-directory entries are skipped; callers do their own
// manifest.json reading/parsing on the yielded folders.
export function* moduleFolders(home: string): Generator<ModuleFolder> {
  for (const [root, source] of [
    [userModulesRoot(home), 'user'] as const,
    [repoModulesRoot(), 'repo'] as const,
  ]) {
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const folder = join(root, entry);
      try {
        if (!statSync(folder).isDirectory()) continue;
      } catch {
        continue;
      }
      yield { folder, source };
    }
  }
}
