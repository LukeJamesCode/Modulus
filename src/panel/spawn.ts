// Shared helper for re-exec'ing the Modulus CLI from the in-process panel.
// Several route families drive `modulus <cmd>` as a child so native-dep setup,
// migrations, and the same code path `modulus …` uses all run: Modules (mod
// enable/disable/install/uninstall) and System (maintenance update). Keeping the
// CLI-entry resolution in one place means a panel-triggered child always re-execs
// the same entrypoint under the same loader (tsx in dev, node in prod).

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PanelDeps } from './types.js';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// The CLI entrypoint to re-exec. Prefers the one we were launched with; falls
// back to the built entry, then source.
export function cliEntryPath(deps: PanelDeps): string {
  if (deps.cliEntry && existsSync(deps.cliEntry)) return deps.cliEntry;
  const built = join(REPO_ROOT, 'dist', 'cli', 'index.js');
  if (existsSync(built)) return built;
  return join(REPO_ROOT, 'src', 'cli', 'index.ts');
}

export function runModulus(
  deps: PanelDeps,
  args: string[],
  timeoutMs = 120_000,
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [...(deps.execArgv ?? []), cliEntryPath(deps), ...args], {
      cwd: REPO_ROOT,
      env: process.env,
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    timer.unref();
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveRun({ code: code ?? -1, out, err });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolveRun({ code: -1, out, err: err + String(e) });
    });
  });
}
