// Bootstraps a heavy module's npm dependencies into the module's own folder
// when it's enabled, so core never has to carry them. The North Star is "heavy
// is opt-in, never core": browser (playwright) and discord (discord.js +
// @discordjs/voice) import third-party packages a Pi-class core install must not
// pay for. Their `setup` entrypoint calls ensureNpmDeps(), which installs the
// missing packages into <module>/node_modules — exactly where the in-process
// `import` resolves them — the first time the module is turned on.
//
// A package that already resolves (a module-local install from a previous
// enable, OR a hoist to the repo root for a dep core does happen to ship) is a
// no-op, so re-enabling is fast and we never reinstall what's already reachable.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface NpmDep {
  // Package name as imported, e.g. 'playwright' or '@discordjs/voice'.
  pkg: string;
  // Version range to install when the package is missing, e.g. '^1.49.0'.
  version: string;
}

export interface EnsureNpmDepsOptions {
  // The module's own folder. Deps install into <folder>/node_modules via
  // `npm install --prefix <folder>`, which is also where Node resolves the
  // module's `import` from at runtime.
  folder: string;
  // Where progress text goes. The panel's enable-stream pipes this over SSE, so
  // a slow install shows live output instead of a dark modal.
  stdout: (text: string) => void;
  // Injected in tests: whether `pkg` already resolves from the module folder.
  isResolvable?: (pkg: string, folder: string) => boolean;
  // Injected in tests: run the install for these `name@version` specs, resolving
  // to the child's exit status (0 = success, non-zero/null = failure).
  runInstall?: (
    folder: string,
    specs: string[],
    stdout: (text: string) => void,
  ) => Promise<number | null>;
}

// A package is "present" if it resolves from the module folder. createRequire
// rooted at a path inside the folder makes Node walk node_modules the same way
// the real `import` will at load time — so this covers a module-local install
// and a repo-root hoist alike.
function defaultIsResolvable(pkg: string, folder: string): boolean {
  try {
    const require = createRequire(pathToFileURL(join(folder, 'setup.js')));
    require.resolve(pkg);
    return true;
  } catch {
    return false;
  }
}

// Stream `npm install --prefix <folder> <specs…>` through `stdout` so the panel
// modal stays alive during a multi-second/minute install. --prefix makes the
// module folder the install root (its own node_modules + package.json), keeping
// the dependency out of core. --no-audit/--no-fund keep the captured output to
// progress. shell:true on win32 so `npm`/`npm.cmd` resolves on PATH.
async function defaultRunInstall(
  folder: string,
  specs: string[],
  stdout: (text: string) => void,
): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(
      'npm',
      ['install', '--prefix', folder, '--no-audit', '--no-fund', ...specs],
      { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' },
    );
    const forward = (d: Buffer): void => {
      try {
        stdout(d.toString('utf8'));
      } catch {
        /* SSE peer gone; let the install finish anyway */
      }
    };
    child.stdout?.on('data', forward);
    child.stderr?.on('data', forward);
    child.on('close', (code) => resolve(code));
    child.on('error', (e) => {
      try {
        stdout(`npm spawn failed: ${e instanceof Error ? e.message : String(e)}\n`);
      } catch {
        /* ignore */
      }
      resolve(-1);
    });
  });
}

// Ensure every dep resolves from the module folder, installing the missing ones
// in a single `npm install`. Returns true when all deps are present afterwards;
// false (with an explanatory line on stdout) if the install failed or a package
// still won't resolve. Best-effort by contract: the caller (a setup entrypoint)
// surfaces the result but does not undo the enable.
export async function ensureNpmDeps(
  deps: readonly NpmDep[],
  opts: EnsureNpmDepsOptions,
): Promise<boolean> {
  const { folder, stdout } = opts;
  const isResolvable = opts.isResolvable ?? defaultIsResolvable;
  const runInstall = opts.runInstall ?? defaultRunInstall;

  const missing = deps.filter((d) => !isResolvable(d.pkg, folder));
  if (missing.length === 0) {
    stdout(`  ✓ ${deps.map((d) => d.pkg).join(', ')} already installed.\n`);
    return true;
  }

  const specs = missing.map((d) => `${d.pkg}@${d.version}`);
  stdout(`  → Installing ${specs.join(', ')} (this can take a minute)…\n`);
  const status = await runInstall(folder, specs, stdout);
  if (status !== 0) {
    stdout(
      `  npm install failed (exit ${status ?? 'unknown'}).\n` +
        `  Install manually:  npm install --prefix ${folder} ${specs.join(' ')}\n`,
    );
    return false;
  }

  const stillMissing = missing.filter((d) => !isResolvable(d.pkg, folder));
  if (stillMissing.length > 0) {
    stdout(
      `  npm install finished but ${stillMissing.map((d) => d.pkg).join(', ')} still won't resolve.\n`,
    );
    return false;
  }
  stdout(`  ✓ Installed ${missing.map((d) => d.pkg).join(', ')}.\n`);
  return true;
}
