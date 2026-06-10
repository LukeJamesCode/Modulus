// `modulus ext` — manage modules.
//
// Subcommands:
//   list                       — installed + enabled state
//   install <name|url|path>    — registry name, git URL, or local folder
//   create <name> [dir]        — scaffold a new module folder ready to publish
//   enable <name>              — flip module_state.enabled = 1
//   disable <name>             — flip module_state.enabled = 0
//   uninstall <name> [--purge] — remove the folder; --purge also drops settings
//   reload [<name>]            — touch the watched directory (or restart hint)
//
// install resolution order for a bare name:
//   1. local path or git URL — direct
//   2. repo-bundled module under <repo>/modules/<name>/
//   3. a public registry: a JSON map of name → git URL, fetched once. The
//      registry URL defaults to the official one and can be overridden with
//      MODULUS_REGISTRY_URL for self-hosted forks.

import { confirm } from '@inquirer/prompts';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { moduleFolders, repoModulesRoot, userModulesRoot } from './module-paths.js';
import { open as openDb } from '../storage/db.js';
import { createLogger } from '../util/log.js';
import { ensurePrivateDir, homeDir } from './config-store.js';
import {
  configureNativeDepsForModule,
  fetchBotUsername,
  setupModules,
  printTelegramCommandsGuide,
} from './ext-setup.js';
import type { Manifest } from '../core/modules.js';
import { collectModuleReadiness, formatModuleReadinessLine } from '../core/module-readiness.js';

interface InstalledExt {
  name: string;
  version: string;
  folder: string;
  source: 'user' | 'repo';
}

// Default registry URL. The repo ships a registry.json at this path so a fresh
// `modulus mod install modulus-foo` works out of the box. Self-hosted forks can
// override with MODULUS_REGISTRY_URL.
const DEFAULT_REGISTRY_URL =
  'https://raw.githubusercontent.com/LukeJamesCode/ModulusAgent/main/modules/registry.json';

interface RegistryEntry {
  name: string;
  source: string; // a git URL we can clone
  // Optional path inside the cloned repo where manifest.json lives. Useful
  // when one repo holds many modules (the monorepo we ship).
  subpath?: string;
  description?: string;
}

async function resolveRegistryEntry(name: string): Promise<RegistryEntry | null> {
  const url = process.env['MODULUS_REGISTRY_URL']?.trim() || DEFAULT_REGISTRY_URL;
  // Try the local repo first so dev installs and offline tests work.
  const localRegistry = join(repoModulesRoot(), 'registry.json');
  if (existsSync(localRegistry)) {
    try {
      const entries = JSON.parse(readFileSync(localRegistry, 'utf8')) as RegistryEntry[];
      const hit = entries.find((e) => e.name === name);
      if (hit) return hit;
    } catch {
      /* fall through to network */
    }
  }
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const entries = (await res.json()) as RegistryEntry[];
    return entries.find((e) => e.name === name) ?? null;
  } catch {
    return null;
  }
}

function listInstalled(home: string): InstalledExt[] {
  const out: InstalledExt[] = [];
  const seen = new Set<string>();
  for (const { folder, source } of moduleFolders(home)) {
    try {
      const m = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')) as {
        name?: string;
        version?: string;
      };
      if (!m.name || !m.version || seen.has(m.name)) continue;
      seen.add(m.name);
      out.push({ name: m.name, version: m.version, folder, source });
    } catch {
      // not a module or malformed manifest; ignore
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function withDb<T>(home: string, fn: (db: ReturnType<typeof openDb>) => T): T {
  const log = createLogger({ level: 'warn' });
  const db = openDb({ path: join(home, 'modulus.db'), log });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

export async function list(): Promise<void> {
  const home = homeDir();
  const readiness = withDb(home, (db) =>
    collectModuleReadiness([userModulesRoot(home), repoModulesRoot()], db),
  );
  if (readiness.length === 0) {
    process.stdout.write('No modules installed.\n');
    return;
  }
  for (const e of readiness) process.stdout.write(formatModuleReadinessLine(e) + '\n');
}

export async function install(source: string | undefined): Promise<void> {
  if (!source) {
    process.stderr.write('Usage: modulus mod install <path|git-url|name>\n');
    process.exit(2);
  }
  const home = homeDir();
  const dest = userModulesRoot(home);
  ensurePrivateDir(dest);

  let installedName: string;
  const local = isLocalPath(source) ? resolve(source) : null;
  if (local && existsSync(local) && statSync(local).isDirectory()) {
    installedName = installFromFolder(local, dest);
  } else if (looksLikeGitUrl(source)) {
    installedName = installFromGit(source, dest);
  } else {
    // Bare name resolution: prefer repo-bundled, then registry lookup.
    const repoCandidate = join(repoModulesRoot(), source);
    if (existsSync(join(repoCandidate, 'manifest.json'))) {
      installedName = installFromFolder(repoCandidate, dest);
    } else {
      const entry = await resolveRegistryEntry(source);
      if (entry) {
        const where = entry.subpath ? `${entry.source}#${entry.subpath}` : entry.source;
        process.stdout.write(`→ Resolved '${source}' from registry: ${where}\n`);
        installedName = installFromGit(entry.source, dest, entry.subpath);
      } else {
        process.stderr.write(
          `Cannot resolve '${source}' as a local path, git URL, repo module, or registry name.\n`,
        );
        process.exit(1);
      }
    }
  }

  // Offer to walk through auth + settings for the newly installed module.
  const extFolder = join(dest, installedName);
  let manifest: Manifest;
  try {
    const raw = JSON.parse(readFileSync(join(extFolder, 'manifest.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    if (
      typeof raw['name'] !== 'string' ||
      typeof raw['version'] !== 'string' ||
      typeof raw['modulus'] !== 'string'
    ) {
      process.stderr.write(
        `Installed module has an invalid manifest.json (missing required fields: name, version, modulus).\n`,
      );
      process.exit(1);
    }
    manifest = raw as unknown as Manifest;
  } catch (e) {
    process.stderr.write(
      `Failed to read installed module manifest: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    process.exit(1);
  }
  const ext = { name: installedName, folder: extFolder, manifest };

  const canPrompt = process.stdin.isTTY && process.stdout.isTTY;
  const doSetup = canPrompt
    ? await confirm({
        message: `Configure ${installedName} now? (auth + settings)`,
        default: true,
      })
    : false;

  if (doSetup) {
    await setupModules(home, [ext]);
    const botUsername = await fetchBotUsername();
    printTelegramCommandsGuide([ext], botUsername, { includeCore: false });
  } else {
    if (manifest.entrypoints?.setup) {
      const log = createLogger({ level: 'warn' });
      const db = openDb({ path: join(home, 'modulus.db'), log });
      try {
        await configureNativeDepsForModule(ext, db, home);
      } finally {
        db.close();
      }
    }
    process.stdout.write(
      (canPrompt
        ? `  Configure later:\n`
        : `  Non-interactive shell detected; configure later:\n`) +
        (manifest.entrypoints?.auth ? `    modulus auth ${installedName}\n` : '') +
        `    modulus config\n`,
    );
  }
}

function isLocalPath(s: string): boolean {
  return s.startsWith('.') || s.startsWith('/') || isAbsolute(s) || s.startsWith('~');
}

// Module names land in `~/.modulus/modules/<name>/`. The manifest is
// untrusted (it's whatever a public repo or local folder shipped), so before
// we join it into a path we have to refuse anything that could escape the
// modules root: path separators, parent references, leading dots, or
// anything that isn't a sensible package-name shape.
const EXT_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i;
function assertSafeExtName(name: string): void {
  if (!EXT_NAME_RE.test(name) || name.includes('..')) {
    process.stderr.write(
      `Manifest 'name' is not a safe module identifier: ${JSON.stringify(name)}\n`,
    );
    process.exit(1);
  }
}

// Belt-and-braces: even with a safe-looking name, make sure the joined
// destination really sits under destRoot. Symlinks in destRoot itself would
// be a separate concern; this guards the string-level traversal.
function assertContained(child: string, parent: string): void {
  const c = resolve(child);
  const p = resolve(parent);
  const rel = c.startsWith(p + (process.platform === 'win32' ? '\\' : '/'));
  if (!rel || c === p) {
    process.stderr.write(`Refusing to write outside modules root: ${c}\n`);
    process.exit(1);
  }
}

function looksLikeGitUrl(s: string): boolean {
  return (
    s.endsWith('.git') ||
    s.startsWith('git@') ||
    /^https?:\/\/[^\s]+\/[^\s]+/.test(s) ||
    /^ssh:\/\//.test(s)
  );
}

function installFromFolder(src: string, destRoot: string): string {
  const manifestPath = join(src, 'manifest.json');
  if (!existsSync(manifestPath)) {
    process.stderr.write(`'${src}' has no manifest.json.\n`);
    process.exit(1);
  }
  const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: string };
  if (!m.name) {
    process.stderr.write(`Manifest at '${manifestPath}' has no name.\n`);
    process.exit(1);
  }
  assertSafeExtName(m.name);
  const dest = join(destRoot, m.name);
  assertContained(dest, destRoot);
  if (existsSync(dest)) {
    process.stderr.write(
      `Destination already exists: ${dest}. Uninstall first or pick another name.\n`,
    );
    process.exit(1);
  }
  cpSync(src, dest, { recursive: true });
  process.stdout.write(`✓ Installed '${m.name}' → ${dest}\n`);
  process.stdout.write(
    `  If modulus is running, hot-reload will pick it up. Otherwise run \`modulus start\`.\n`,
  );
  return m.name;
}

// Conservative shape check on a Git URL. Accepts http(s):// and git@host:path
// forms; rejects file:// and bare local paths to head off accidents like
// `modulus mod install ../whatever`. Git itself wouldn't be tricked here, but
// the wrong path silently bypasses the rest of installFromGit's manifest
// validation and leaves a stray clone in destRoot.
const GIT_URL_RE = /^(https?:\/\/|git@)[A-Za-z0-9._-]+(:[0-9]+)?[/:][A-Za-z0-9._\-/]+(\.git)?$/;

function installFromGit(url: string, destRoot: string, subpath?: string): string {
  if (!GIT_URL_RE.test(url)) {
    process.stderr.write(
      `'${url}' doesn't look like a git URL (expected https://… or git@host:path).\n`,
    );
    process.exit(1);
  }
  // Use a temp folder so we can read manifest.json before naming the final dir.
  // randomUUID() avoids the millisecond collision two concurrent installs would
  // otherwise hit on `Date.now()`.
  const tmp = join(destRoot, `.tmp-clone-${randomUUID()}`);
  const r = spawnSync('git', ['clone', '--depth', '1', url, tmp], { stdio: 'inherit' });
  if (r.status !== 0) {
    process.stderr.write(`git clone failed (exit ${r.status}).\n`);
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    process.exit(1);
  }
  const sourceRoot = subpath ? join(tmp, subpath) : tmp;
  if (subpath) assertContained(sourceRoot, tmp);
  const manifestPath = join(sourceRoot, 'manifest.json');
  if (!existsSync(manifestPath)) {
    rmSync(tmp, { recursive: true, force: true });
    process.stderr.write(
      subpath
        ? `Cloned repo has no manifest.json at '${subpath}'.\n`
        : `Cloned repo has no manifest.json.\n`,
    );
    process.exit(1);
  }
  const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: string };
  if (!m.name) {
    rmSync(tmp, { recursive: true, force: true });
    process.stderr.write(`Cloned manifest has no name.\n`);
    process.exit(1);
  }
  assertSafeExtName(m.name);
  const dest = join(destRoot, m.name);
  assertContained(dest, destRoot);
  if (existsSync(dest)) {
    rmSync(tmp, { recursive: true, force: true });
    process.stderr.write(`Destination already exists: ${dest}.\n`);
    process.exit(1);
  }
  cpSync(sourceRoot, dest, { recursive: true });
  rmSync(tmp, { recursive: true, force: true });
  process.stdout.write(`✓ Cloned '${m.name}' from ${url} → ${dest}\n`);
  return m.name;
}

export async function enable(name: string | undefined): Promise<void> {
  if (!name) {
    process.stderr.write('Usage: modulus mod enable <name>\n');
    process.exit(2);
  }
  await setEnabled(name, true);
}

export async function disable(name: string | undefined): Promise<void> {
  if (!name) {
    process.stderr.write('Usage: modulus mod disable <name>\n');
    process.exit(2);
  }
  await setEnabled(name, false);
}

async function setEnabled(name: string, enabled: boolean): Promise<void> {
  const home = homeDir();
  const installed = listInstalled(home).find((e) => e.name === name);
  if (!installed) {
    process.stderr.write(`Module '${name}' is not installed.\n`);
    process.exit(1);
  }
  withDb(home, (db) => {
    // INSERT OR UPDATE: if the loader has never run, the row doesn't exist
    // yet; we still want enable/disable to take effect on next load.
    const now = Date.now();
    db.prepare(
      `INSERT INTO module_state (name, version, enabled, installed_at, last_loaded_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET enabled = excluded.enabled`,
    ).run(installed.name, installed.version, enabled ? 1 : 0, now, now);
  });
  process.stdout.write(`${enabled ? '✓ Enabled' : '✓ Disabled'} '${name}'.\n`);
  process.stdout.write(
    enabled
      ? `  The loader will pick it up on the next start or hot-reload tick.\n`
      : `  Restart modulus (or hot-reload) to fully unload it.\n`,
  );
}

export async function uninstall(
  name: string | undefined,
  opts: { purge?: boolean } = {},
): Promise<void> {
  if (!name) {
    process.stderr.write('Usage: modulus mod uninstall <name> [--purge]\n');
    process.exit(2);
  }
  const home = homeDir();
  const userFolder = join(userModulesRoot(home), name);
  if (!existsSync(userFolder)) {
    process.stderr.write(
      `'${name}' is not installed under ${userModulesRoot(home)}. Repo-bundled modules live under <repo>/modules and aren't managed here.\n`,
    );
    process.exit(1);
  }
  rmSync(userFolder, { recursive: true, force: true });
  if (opts.purge) {
    withDb(home, (db) => {
      db.prepare(`DELETE FROM module_settings WHERE module = ?`).run(name);
      db.prepare(`DELETE FROM module_state WHERE name = ?`).run(name);
    });
  }
  process.stdout.write(
    `✓ Uninstalled '${name}'.${opts.purge ? ' (settings purged)' : ' (settings kept; pass --purge to drop)'}\n`,
  );
}

export async function reload(name: string | undefined): Promise<void> {
  // We can't reach into a running modulus process from a separate CLI process
  // without IPC. For Phase 3, `reload` simply touches the module folder so
  // the file watcher in a running modulus picks up the change. If modulus isn't
  // running this is a no-op and we tell the user to start it.
  const home = homeDir();
  const installed = listInstalled(home);
  if (name) {
    const ext = installed.find((e) => e.name === name);
    if (!ext) {
      process.stderr.write(`Module '${name}' not installed.\n`);
      process.exit(1);
    }
    touchFolder(ext.folder);
    process.stdout.write(`✓ Touched ${ext.folder} (running modulus will hot-reload).\n`);
    return;
  }
  for (const ext of installed) touchFolder(ext.folder);
  process.stdout.write(`✓ Touched ${installed.length} module folder(s).\n`);
}

function touchFolder(folder: string): void {
  // Update the manifest's mtime by re-writing its contents byte-for-byte.
  // (utimesSync would be lighter but cp/test environments sometimes balk.)
  const m = join(folder, 'manifest.json');
  if (existsSync(m)) {
    const txt = readFileSync(m, 'utf8');
    writeFileSync(m, txt, 'utf8');
  }
}

// `modulus mod create <name> [dir]` — drop a runnable starter module into
// `<dir>/<name>/` (default: cwd). The result has a manifest, a tools entrypoint,
// a Telegram command, a settings schema, and a README — enough that
// `modulus mod install ./<name>` works immediately and the author can edit
// from there.
export async function create(
  name: string | undefined,
  parentDir: string | undefined,
): Promise<void> {
  if (!name) {
    process.stderr.write('Usage: modulus mod create <name> [dir]\n');
    process.exit(2);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    process.stderr.write(
      `Invalid module name '${name}'. Use lowercase letters, digits, and hyphens; start with a letter or digit.\n`,
    );
    process.exit(1);
  }
  const parent = parentDir ? resolve(parentDir) : process.cwd();
  const dest = join(parent, name);
  if (existsSync(dest)) {
    process.stderr.write(`Refusing to overwrite existing path: ${dest}\n`);
    process.exit(1);
  }
  mkdirSync(dest, { recursive: true });
  // Strip a leading "modulus-" so e.g. "modulus-todo" surfaces nicely as "todo".
  const short = name.replace(/^modulus-/, '');
  const slashCmd = short.replace(/-/g, '');

  writeFileSync(
    join(dest, 'manifest.json'),
    JSON.stringify(
      {
        name,
        version: '0.1.0',
        description: `One-line description of ${name}.`,
        modulus: '>=0.1.0',
        deps: [],
        capabilities: ['telegram'],
        entrypoints: { tools: './tools.ts', commands: './commands.ts' },
        telegram_commands: [{ command: slashCmd, description: `Run ${name}` }],
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  writeFileSync(
    join(dest, 'tools.ts'),
    `import type { Host } from '../../src/core/modules.js';\n\n` +
      `export function register(host: Host): void {\n` +
      `  host.tools.register({\n` +
      `    name: '${slashCmd}_ping',\n` +
      `    description: 'Sample tool from ${name}. Replace me.',\n` +
      `    parameters: { type: 'object', properties: {} },\n` +
      `    tier: 'auto',\n` +
      `    handler: async () => ({ ok: true, result: 'pong' }),\n` +
      `  });\n` +
      `}\n`,
    'utf8',
  );

  writeFileSync(
    join(dest, 'commands.ts'),
    `import type { Host } from '../../src/core/modules.js';\n\n` +
      `export function register(host: Host): void {\n` +
      `  host.telegram.command(\n` +
      `    '${slashCmd}',\n` +
      `    async (ctx) => {\n` +
      `      await ctx.reply('Hello from ${name}. Edit commands.ts to make me useful.');\n` +
      `    },\n` +
      `    'Run ${name}',\n` +
      `  );\n` +
      `}\n`,
    'utf8',
  );

  writeFileSync(
    join(dest, 'settings.schema.json'),
    JSON.stringify(
      {
        type: 'object',
        properties: {
          example_setting: {
            type: 'string',
            description: 'Replace me with a real setting (or delete this file).',
            default: '',
          },
        },
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  writeFileSync(
    join(dest, 'README.md'),
    `# ${name}\n\n` +
      `One-line description of what this module does.\n\n` +
      `## Install\n\n` +
      `From a local checkout:\n\n` +
      '```sh\n' +
      `modulus mod install ./${name}\n` +
      '```\n\n' +
      `From a git URL (after you push):\n\n` +
      '```sh\n' +
      `modulus mod install https://github.com/<you>/${name}.git\n` +
      '```\n\n' +
      `## What it ships\n\n` +
      `- Tool: \`${slashCmd}_ping\` — sample LLM tool, replace it\n` +
      `- Telegram command: \`/${slashCmd}\`\n\n` +
      `## Settings\n\n` +
      `See \`settings.schema.json\`. Edit values via \`modulus config\`.\n\n` +
      `## Publishing\n\n` +
      `Push this folder to its own git repo, then either:\n\n` +
      `- Tell users \`modulus mod install <git-url>\`, or\n` +
      `- Open a PR to \`modules/registry.json\` in the Modulus repo so \`modulus mod install ${name}\` resolves it by bare name.\n`,
    'utf8',
  );

  writeFileSync(join(dest, '.gitignore'), `node_modules\n*.log\n.DS_Store\n`, 'utf8');

  process.stdout.write(`✓ Scaffolded '${name}' at ${dest}\n`);
  process.stdout.write(`  Next steps:\n`);
  process.stdout.write(`    1. Edit tools.ts / commands.ts to do something useful.\n`);
  process.stdout.write(`    2. modulus mod install ${dest}\n`);
  process.stdout.write(`    3. (optional) push to git, then open a PR to modules/registry.json.\n`);
}
