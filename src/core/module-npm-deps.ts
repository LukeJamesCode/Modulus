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
import { readFileSync } from 'node:fs';
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

// Quote one cmd.exe argument that may contain spaces. On win32 the npm spawn
// runs through a shell (npm is npm.cmd, which Node refuses to launch without
// one — CVE-2024-27980), and a shell word-splits on spaces. A module folder
// like `C:\Users\My Name\.modulus\modules\x` would otherwise arrive as two
// arguments and `npm install --prefix` would point at the wrong place (or
// fail). Windows paths can't contain a literal `"`, so wrapping in double
// quotes is sufficient and safe for the filesystem paths we pass.
function quoteWin32Arg(arg: string): string {
  return /\s/.test(arg) ? `"${arg}"` : arg;
}

// Build the `npm install` invocation. Extracted as a pure function so the
// spaces-in-path quoting is unit-testable without actually spawning npm.
// shell:true on win32 so cmd.exe resolves `npm` → `npm.cmd` on PATH; args are
// quoted to survive that shell. POSIX needs neither.
export function npmInstallInvocation(
  folder: string,
  specs: string[],
): { command: string; args: string[]; shell: boolean } {
  // --save-exact pins the resolved version into the module folder's package.json
  // (no caret), so a later reinstall reproduces exactly what's running rather
  // than silently drifting to a newer minor. The version we record in
  // module_state comes from node_modules, but pinning keeps the two in step.
  const raw = ['install', '--prefix', folder, '--save-exact', '--no-audit', '--no-fund', ...specs];
  const win32 = process.platform === 'win32';
  return {
    command: 'npm',
    args: win32 ? raw.map(quoteWin32Arg) : raw,
    shell: win32,
  };
}

// Stream `npm install --prefix <folder> <specs…>` through `stdout` so the panel
// modal stays alive during a multi-second/minute install. --prefix makes the
// module folder the install root (its own node_modules + package.json), keeping
// the dependency out of core. --no-audit/--no-fund keep the captured output to
// progress.
async function defaultRunInstall(
  folder: string,
  specs: string[],
  stdout: (text: string) => void,
): Promise<number | null> {
  return new Promise((resolve) => {
    const { command, args, shell } = npmInstallInvocation(folder, specs);
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell,
    });
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

// Resolve a package's package.json path from the module folder, the same way
// the runtime `import` will at load time (createRequire rooted in the folder).
// Returns undefined when the package doesn't resolve.
function defaultResolvePkgJson(pkg: string, folder: string): string | undefined {
  try {
    const require = createRequire(pathToFileURL(join(folder, 'setup.js')));
    return require.resolve(`${pkg}/package.json`);
  } catch {
    return undefined;
  }
}

// Read the exact installed version of each dep from the module folder's
// node_modules, so the host can record what's actually pinned (not the declared
// range). A dep that doesn't resolve is omitted — we never record a version we
// can't read off disk. `resolvePkgJson` is injectable for tests.
export function readInstalledVersions(
  folder: string,
  deps: readonly NpmDep[],
  resolvePkgJson: (pkg: string, folder: string) => string | undefined = defaultResolvePkgJson,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of deps) {
    const pkgJsonPath = resolvePkgJson(d.pkg, folder);
    if (!pkgJsonPath) continue;
    try {
      const v = (JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { version?: unknown }).version;
      if (typeof v === 'string' && v.length > 0) out[d.pkg] = v;
    } catch {
      /* unreadable package.json; skip rather than record a guess */
    }
  }
  return out;
}
