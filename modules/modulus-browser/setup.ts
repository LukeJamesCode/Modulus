// Setup entrypoint for modulus-browser. Runs on enable/install (the panel's
// enable-stream and `modulus mod install` both call it) and bootstraps the two
// heavy things core deliberately doesn't ship: the `playwright` npm package and
// a Chromium browser binary. Without these the module's tools.ts can't even
// import `playwright`, so this is what makes a freshly-enabled browser module
// actually work. Best-effort: a failed step reports how to finish by hand and
// does not undo the enable.

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { ModuleSetupContext } from '../../src/core/modules.js';

// Pinned to a current Playwright line; caret lets a patch/minor land. The
// browser binary is matched by `playwright install` to whatever resolves here.
const PLAYWRIGHT_VERSION = '^1.49.0';

// Drive the freshly-installed Playwright CLI to download Chromium. We invoke the
// module-local install directly (node <folder>/node_modules/playwright/cli.js)
// rather than `npx`, so it works regardless of PATH and uses exactly the version
// we just installed. Chromium lands in Playwright's own cache (~/.cache/
// ms-playwright or the OS equivalent), not the module folder. Streams output so
// the panel modal shows the ~150MB download progressing instead of going dark.
async function installChromium(folder: string, stdout: (text: string) => void): Promise<boolean> {
  const cli = join(folder, 'node_modules', 'playwright', 'cli.js');
  stdout('  → Downloading Chromium for Playwright…\n');
  const status = await new Promise<number | null>((resolve) => {
    const child = spawn(process.execPath, [cli, 'install', 'chromium'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const forward = (d: Buffer): void => {
      try {
        stdout(d.toString('utf8'));
      } catch {
        /* SSE peer gone; let the download finish */
      }
    };
    child.stdout?.on('data', forward);
    child.stderr?.on('data', forward);
    child.on('close', (code) => resolve(code));
    child.on('error', (e) => {
      try {
        stdout(`  playwright spawn failed: ${e instanceof Error ? e.message : String(e)}\n`);
      } catch {
        /* ignore */
      }
      resolve(-1);
    });
  });
  if (status !== 0) {
    stdout(
      `  Chromium download failed (exit ${status ?? 'unknown'}).\n` +
        `  Finish by hand:  node ${cli} install chromium\n`,
    );
    return false;
  }
  stdout('  ✓ Chromium ready.\n');
  return true;
}

export async function setup(ctx: ModuleSetupContext): Promise<void> {
  const ok = await ctx.ensureNpmDeps([{ pkg: 'playwright', version: PLAYWRIGHT_VERSION }]);
  // Only fetch the browser binary once the package that drives the download is
  // actually present — otherwise the CLI path doesn't exist yet.
  if (ok) await installChromium(ctx.folder, ctx.stdout);
}
