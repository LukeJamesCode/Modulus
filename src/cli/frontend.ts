// Internal entry for the modulus-frontend web panel.
//
// Not a user-facing subcommand — it's invoked as `modulus __panel` (hidden in
// --help) by spawnPanel() in panel.ts, so the panel runs in its own process,
// separate from the agent daemon. Users drive the panel through `modulus start`
// (spawns it) and `modulus stop` (kills it).
//
// The actual HTTP server lives in the extension (extensions/modulus-frontend/
// server.ts) so it can ship, hot-reload, and own its assets. This file is a
// thin shim that resolves that server by absolute path and runs it. tsx
// (registered in index.ts) transpiles the .ts on the fly.

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { acquirePanelPid, releasePanelPid } from './panel.js';
import { ensurePrivateDir, homeDir } from './config-store.js';

function serverModulePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', 'extensions', 'modulus-frontend', 'server.ts');
}

export async function run(): Promise<void> {
  const home = homeDir();
  ensurePrivateDir(home);

  if (!acquirePanelPid(home)) {
    throw new Error("modulus-frontend is already running. Use 'modulus stop' first if stale.");
  }
  process.once('exit', () => releasePanelPid(home));

  const modPath = serverModulePath();
  if (!existsSync(modPath)) {
    releasePanelPid(home);
    throw new Error(
      `modulus-frontend is not installed (expected ${modPath}). Install it with 'modulus ext install modulus-frontend'.`,
    );
  }
  const mod = (await import(pathToFileURL(modPath).href)) as {
    run: (opts: { cliEntry?: string; execArgv?: string[] }) => Promise<unknown>;
  };
  await mod.run({
    cliEntry: process.argv[1] ?? join(dirname(fileURLToPath(import.meta.url)), 'index.js'),
    execArgv: process.execArgv,
  });
}
