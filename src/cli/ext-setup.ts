// Shared extension setup logic used by both `modulus init` and `modulus ext install`.
//
// Covers:
//   - Running an extension's auth flow (if it declares one)
//   - Prompting for remaining non-secret, no-default settings
//   - Printing the BotFather /setcommands guide for all active extensions

import { confirm, input } from '@inquirer/prompts';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { open as openDb, type DB } from '../storage/db.js';
import { createLogger } from '../util/log.js';
import { runAuthForExt, type DiscoveredExtension } from './auth.js';
import type {
  ExtensionSettings,
  ExtensionSetupContext,
  SettingsSchema,
  SetupEntrypointModule,
} from '../core/extensions.js';
import { effectiveConfig, homeDir } from './config-store.js';

export type { DiscoveredExtension };

// Slash commands registered by the Modulus core itself (not via extensions).
const CORE_COMMANDS: ReadonlyArray<{ command: string; description: string }> = [
  { command: 'start', description: 'Start the bot and get a greeting' },
];

export interface SettingsPromptIO {
  prompt(question: string, opts?: { secret?: boolean; default?: string }): Promise<string>;
  confirm(question: string, defaultValue: boolean): Promise<boolean>;
  print(line: string): void;
}

export async function promptRemainingSettings(
  extName: string,
  folder: string,
  db: DB,
  ioOverride?: SettingsPromptIO,
): Promise<void> {
  const schemaPath = join(folder, 'settings.schema.json');
  if (!existsSync(schemaPath)) return;
  let schema: SettingsSchema;
  try {
    schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as SettingsSchema;
  } catch {
    return;
  }

  const alreadySet = new Set(
    (
      db.prepare(`SELECT key FROM extension_settings WHERE extension = ?`).all(extName) as Array<{
        key: string;
      }>
    ).map((r) => r.key),
  );

  const insertSetting = db.prepare(
    `INSERT INTO extension_settings (extension, key, value, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(extension, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );

  // Prompt for every non-secret field — including ones with defaults — so the
  // user can personalize on first run instead of discovering `modulus config`
  // weeks later. Pressing Enter accepts the default and we skip the DB write,
  // which keeps the schema's default "live" for future upgrades.
  for (const [key, def] of Object.entries(schema.properties)) {
    if (alreadySet.has(key)) continue;
    if (def.secret) continue; // secrets belong to the auth flow
    if (
      extName === 'modulus-voice' &&
      (key === 'piper_bin' || key === 'ffmpeg_bin' || key === 'whisper_bin')
    )
      continue;

    const isRequired = schema.required?.includes(key) ?? false;
    const label = def.description ?? key;
    const hasDefault = def.default !== undefined;

    if (def.type === 'boolean') {
      const ans = ioOverride
        ? await ioOverride.confirm(`  ${label}`, hasDefault ? Boolean(def.default) : false)
        : await confirm({
            message: `  ${label}`,
            default: hasDefault ? Boolean(def.default) : false,
          });
      if (!hasDefault || ans !== Boolean(def.default)) {
        insertSetting.run(extName, key, ans ? 'true' : 'false', Date.now());
      }
      continue;
    }

    const suffix = !isRequired && !hasDefault ? ' (optional — press Enter to skip)' : '';
    let raw: string;
    if (ioOverride) {
      raw = await ioOverride.prompt(`  ${label}${suffix}:`, {
        ...(hasDefault ? { default: String(def.default) } : {}),
      });
    } else {
      const promptOpts: Parameters<typeof input>[0] = { message: `  ${label}${suffix}:` };
      if (hasDefault) promptOpts.default = String(def.default);
      raw = await input(promptOpts);
    }
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (hasDefault && trimmed === String(def.default)) continue;

    if (def.type === 'number' && !Number.isFinite(Number(trimmed))) {
      if (ioOverride) ioOverride.print('    (not a number, skipped)');
      else process.stdout.write(`    (not a number, skipped)\n`);
      continue;
    }
    insertSetting.run(extName, key, trimmed, Date.now());
  }
}

function upsertSetting(db: DB, extName: string, key: string, value: string): void {
  db.prepare(
    `INSERT INTO extension_settings (extension, key, value, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(extension, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(extName, key, value, Date.now());
}

function setupSettings(db: DB, extName: string): ExtensionSettings {
  return {
    get<T = unknown>(key: string, fallback?: T): T {
      const row = db
        .prepare(`SELECT value FROM extension_settings WHERE extension = ? AND key = ?`)
        .get(extName, key) as { value: string } | undefined;
      if (!row) return fallback as T;
      return row.value as T;
    },
    set(key: string, value: string | number | boolean): void {
      upsertSetting(db, extName, key, String(value));
    },
    all(): Record<string, string | number | boolean> {
      const rows = db
        .prepare(`SELECT key, value FROM extension_settings WHERE extension = ?`)
        .all(extName) as Array<{ key: string; value: string }>;
      return Object.fromEntries(rows.map((row) => [row.key, row.value]));
    },
  };
}

export interface NativeDepsSetupOptions {
  // Force the setup context's interactivity. Defaults to detecting a TTY. The
  // web panel passes `false` so a setup entrypoint can never block on an
  // inquirer prompt the browser can't answer.
  interactive?: boolean;
  // Where the entrypoint's progress text goes. Defaults to process.stdout.
  stdout?: (text: string) => void;
}

async function runSetupEntrypoint(
  ext: DiscoveredExtension,
  db: DB,
  home: string,
  opts: NativeDepsSetupOptions = {},
): Promise<void> {
  const entry = ext.manifest.entrypoints?.setup;
  if (!entry) return;
  const setupPath = join(ext.folder, entry);
  const stdout = opts.stdout ?? ((text: string) => process.stdout.write(text));
  if (!existsSync(setupPath)) {
    stdout(`  Setup entrypoint not found: ${entry}\n`);
    return;
  }
  const mtime = statSync(setupPath).mtimeMs;
  const mod = (await import(
    `${pathToFileURL(setupPath).href}?v=${mtime}`
  )) as SetupEntrypointModule;
  const fn = mod.setup ?? mod.run;
  if (!fn) {
    stdout(`  Setup entrypoint has no setup(ctx) or run(ctx) export: ${entry}\n`);
    return;
  }
  const ctx: ExtensionSetupContext = {
    name: ext.name,
    folder: ext.folder,
    home,
    db,
    interactive: opts.interactive ?? (process.stdin.isTTY && process.stdout.isTTY),
    stdout,
    settings: setupSettings(db, ext.name),
  };
  await fn(ctx);
}

export async function configureNativeDepsForExtension(
  ext: DiscoveredExtension,
  db: DB,
  home: string = homeDir(),
  opts: NativeDepsSetupOptions = {},
): Promise<void> {
  await runSetupEntrypoint(ext, db, home, opts);
}

// Run the auth + settings wizard for one extension using an already-open DB.
// Returns true if auth succeeded (or wasn't needed), false if auth failed.
export async function setupExtension(
  ext: DiscoveredExtension,
  db: DB,
  home: string = homeDir(),
): Promise<boolean> {
  process.stdout.write(`\nConfiguring ${ext.name}…\n`);
  let authOk = true;

  if (ext.manifest.entrypoints?.auth) {
    try {
      await runAuthForExt(ext, db);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stdout.write(`  ✗ Auth failed: ${msg}\n`);
      process.stdout.write(`  Run \`modulus auth ${ext.name}\` to retry.\n`);
      authOk = false;
    }
  }

  await promptRemainingSettings(ext.name, ext.folder, db);
  await configureNativeDepsForExtension(ext, db, home);
  process.stdout.write(`  ✓ ${ext.name} configured.\n`);
  return authOk;
}

// Run the setup wizard for a list of extensions, sharing one DB connection.
export async function setupExtensions(
  home: string,
  selected: DiscoveredExtension[],
): Promise<void> {
  if (selected.length === 0) return;

  const log = createLogger({ level: 'warn' });
  const db = openDb({ path: join(home, 'modulus.db'), log });
  const needsAuthLater: string[] = [];

  try {
    for (const ext of selected) {
      const ok = await setupExtension(ext, db, home);
      if (!ok) needsAuthLater.push(ext.name);
    }
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }

  if (needsAuthLater.length > 0) {
    process.stdout.write(
      '\nThese extensions need auth — retry once the bot is running:\n' +
        needsAuthLater.map((n) => `  modulus auth ${n}`).join('\n') +
        '\n',
    );
  }
}

// Best-effort bot username lookup so the BotFather guide can name the right
// bot. Returns undefined if no token is configured or the call fails — the
// guide gracefully degrades to "your bot".
export async function fetchBotUsername(): Promise<string | undefined> {
  try {
    const cfg = effectiveConfig();
    if (!cfg.telegram.token) return undefined;
    const res = await fetch(`https://api.telegram.org/bot${cfg.telegram.token}/getMe`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return undefined;
    const j = (await res.json()) as { result?: { username?: string } };
    return j.result?.username;
  } catch {
    return undefined;
  }
}

export interface CommandGuideOptions {
  // Include the core /start command in the printed list. True for `modulus
  // init` (first-time setup); false for follow-on runs like `modulus auth` or
  // `modulus ext install` where /start is already in BotFather.
  includeCore?: boolean;
}

// Print a formatted BotFather /setcommands guide for the given extensions.
// Pass the bot username (without @) when known so the instructions are specific.
export function printTelegramCommandsGuide(
  extensions: DiscoveredExtension[],
  botUsername?: string,
  options: CommandGuideOptions = {},
): void {
  const includeCore = options.includeCore ?? true;
  const extCommands = extensions.flatMap((e) => e.manifest.telegram_commands ?? []);
  const allCommands = includeCore ? [...CORE_COMMANDS, ...extCommands] : extCommands;
  if (allCommands.length === 0) return;

  const commandList = allCommands.map((c) => `${c.command} - ${c.description}`).join('\n');
  const bot = botUsername ? `@${botUsername}` : 'your bot';

  process.stdout.write(
    '\n─────────────────────────────────────────────────\n' +
      'Telegram commands — register these with @BotFather:\n\n' +
      '  1. Open @BotFather in Telegram\n' +
      '  2. Send: /setcommands\n' +
      `  3. Select ${bot}\n` +
      '  4. Paste the block below:\n\n' +
      commandList +
      '\n\n─────────────────────────────────────────────────\n',
  );
}
