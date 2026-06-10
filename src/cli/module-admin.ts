// Shared enable / disable / uninstall logic for installed modules.
//
// The DB flips and folder removals these verbs perform are identical whether a
// user types `modulus mod enable x` or clicks Enable in the panel. Before, the
// panel re-exec'd the CLI as a child process to do this — paying a full Node +
// tsx boot on every toggle and running the work in a *different* process than
// the live loader, so the running daemon only noticed by accident (a watcher
// tick). These functions are the one code path both surfaces call: pure
// DB/filesystem operations with no process I/O and no process.exit, returning a
// result the caller renders. The panel pairs them with its in-process loader
// (reload on enable, unload on disable/uninstall); the CLI prints + exits.

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '../storage/db.js';
import { moduleFolders, userModulesRoot } from './module-paths.js';

export interface InstalledModuleRef {
  name: string;
  version: string;
  folder: string;
  source: 'user' | 'repo';
}

// Find an installed module by name across user + repo roots (user wins, as in
// the loader). Returns undefined when nothing claims that name.
export function findInstalledModule(home: string, name: string): InstalledModuleRef | undefined {
  for (const { folder, source } of moduleFolders(home)) {
    try {
      const m = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')) as {
        name?: string;
        version?: string;
      };
      if (m.name === name && m.version) return { name, version: m.version, folder, source };
    } catch {
      // not a module or malformed manifest; keep looking
    }
  }
  return undefined;
}

export interface EnableResult {
  ok: boolean;
  error?: string;
  version?: string;
}

// Flip module_state.enabled. INSERT-or-UPDATE so enable/disable takes effect
// even if the loader has never created the row yet (it'll be honored on next
// load). Pure DB write — the caller drives any live loader reload/unload.
export function setModuleEnabledState(
  db: DB,
  home: string,
  name: string,
  enabled: boolean,
): EnableResult {
  const installed = findInstalledModule(home, name);
  if (!installed) return { ok: false, error: `Module '${name}' is not installed.` };
  const now = Date.now();
  db.prepare(
    `INSERT INTO module_state (name, version, enabled, installed_at, last_loaded_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET enabled = excluded.enabled`,
  ).run(installed.name, installed.version, enabled ? 1 : 0, now, now);
  return { ok: true, version: installed.version };
}

export interface UninstallResult {
  ok: boolean;
  error?: string;
}

// Remove a user-installed module's folder, optionally purging its persisted
// settings + state. Repo-bundled modules live under <repo>/modules and are not
// managed here — only the user root is touched, so this can never delete a
// shipped module. Pass the DB only when purging.
export function uninstallModuleFiles(
  home: string,
  name: string,
  opts: { purge?: boolean; db?: DB } = {},
): UninstallResult {
  const userFolder = join(userModulesRoot(home), name);
  if (!existsSync(userFolder)) {
    return {
      ok: false,
      error: `'${name}' is not installed under ${userModulesRoot(home)}. Repo-bundled modules live under <repo>/modules and aren't managed here.`,
    };
  }
  rmSync(userFolder, { recursive: true, force: true });
  if (opts.purge && opts.db) {
    opts.db.prepare(`DELETE FROM module_settings WHERE module = ?`).run(name);
    opts.db.prepare(`DELETE FROM module_state WHERE name = ?`).run(name);
  }
  return { ok: true };
}
