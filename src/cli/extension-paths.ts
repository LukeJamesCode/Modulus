// Shared filesystem layout for installed extensions. Both the repo-bundled
// extensions (shipped alongside the CLI) and user-installed ones (under
// ~/.modulus/extensions) are scanned by several commands (status, doctor,
// config, auth, ext). This module owns the roots and the directory walk so
// those commands don't each re-implement the same readdir/stat skeleton.

import { readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function repoExtensionsRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', 'extensions');
}

export function userExtensionsRoot(home: string): string {
  return join(home, 'extensions');
}

export interface ExtensionFolder {
  folder: string;
  source: 'user' | 'repo';
}

// Yield each candidate extension directory, user installs first then bundled.
// Unreadable roots and non-directory entries are skipped; callers do their own
// manifest.json reading/parsing on the yielded folders.
export function* extensionFolders(home: string): Generator<ExtensionFolder> {
  for (const [root, source] of [
    [userExtensionsRoot(home), 'user'] as const,
    [repoExtensionsRoot(), 'repo'] as const,
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
