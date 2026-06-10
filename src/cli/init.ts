// `modulus init` — first-run wizard.
//
// Walks the user through the bare minimum needed to launch the bot:
//   1. Where to put the config dir
//   2. Telegram bot token (validated against /getMe)
//   3. Allowed Telegram user IDs
//   4. Ollama URL (validated by listing models)
//   5. Pick chat / reasoning profile models from the live model list
//   6. Hardware tier (auto-suggested from RAM, overridable)
//   7. Module selection — choose which bundled modules to enable,
//      then fill in their required settings and auth tokens on the spot.
//
// The wizard is idempotent: re-running it loads existing config and lets the
// user step through each value, accepting the previous one as the default.

import { checkbox, confirm, input, password, select } from '@inquirer/prompts';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectTier } from './tier.js';
import {
  effectiveConfig,
  homeDir,
  loadConfig,
  parseAllowedIds,
  saveConfig,
  type ModulusConfig,
} from './config-store.js';
import { probeOllama } from './ollama-probe.js';
import { availableModelTags } from './model-options.js';
import { open as openDb } from '../storage/db.js';
import { createLogger } from '../util/log.js';
import { setupModules, printTelegramCommandsGuide, type DiscoveredModule } from './ext-setup.js';
import type { Manifest } from '../core/modules.js';

const TELEGRAM_API = 'https://api.telegram.org';

interface BotInfo {
  ok: boolean;
  username?: string;
}

async function validateBotToken(token: string): Promise<BotInfo> {
  try {
    const res = await fetch(`${TELEGRAM_API}/bot${token}/getMe`);
    if (!res.ok) return { ok: false };
    const j = (await res.json()) as { ok?: boolean; result?: { username?: string } };
    return { ok: !!j.ok, ...(j.result?.username ? { username: j.result.username } : {}) };
  } catch {
    return { ok: false };
  }
}

// ---------------------------------------------------------------------------
// Module discovery + setup
// ---------------------------------------------------------------------------

function discoverBundledModules(): DiscoveredModule[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoModule = resolve(here, '..', '..', 'modules');
  const out: DiscoveredModule[] = [];
  let entries: string[];
  try {
    entries = readdirSync(repoModule);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const folder = join(repoModule, entry);
    try {
      if (!statSync(folder).isDirectory()) continue;
      const manifestPath = join(folder, 'manifest.json');
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
      if (typeof manifest.name === 'string') out.push({ name: manifest.name, folder, manifest });
    } catch {
      /* skip malformed */
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export interface ModuleSelectionPlan {
  modules: DiscoveredModule[];
  addedDependencies: string[];
  missingDependencies: Array<{ module: string; dependency: string }>;
}

export function resolveModuleSelection(
  bundled: DiscoveredModule[],
  selectedNames: readonly string[],
): ModuleSelectionPlan {
  const byName = new Map(bundled.map((mod) => [mod.name, mod]));
  const requested = new Set(selectedNames);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: DiscoveredModule[] = [];
  const added = new Set<string>();
  const missingDependencies: Array<{ module: string; dependency: string }> = [];

  const visit = (name: string, parent?: string): void => {
    if (visited.has(name)) return;
    if (visiting.has(name)) return;

    const mod = byName.get(name);
    if (!mod) {
      if (parent) missingDependencies.push({ module: parent, dependency: name });
      return;
    }

    visiting.add(name);
    for (const dep of mod.manifest.deps ?? []) {
      visit(dep, mod.name);
      if (!requested.has(dep) && byName.has(dep)) added.add(dep);
    }
    visiting.delete(name);
    visited.add(name);
    ordered.push(mod);
  };

  for (const name of selectedNames) visit(name);

  return {
    modules: ordered,
    addedDependencies: [...added].sort((a, b) => a.localeCompare(b)),
    missingDependencies,
  };
}

// Write module_state rows for every bundled module BEFORE the loader
// runs, so unselected ones don't get auto-enabled on first start. Selected
// modules get enabled=1; everything else gets enabled=0.
function presetModuleStates(
  home: string,
  bundled: DiscoveredModule[],
  selectedNames: string[],
): void {
  const log = createLogger({ level: 'warn' });
  const db = openDb({ path: join(home, 'modulus.db'), log });
  try {
    const stmt = db.prepare(
      `INSERT INTO module_state (name, version, enabled, installed_at, last_loaded_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET enabled = excluded.enabled`,
    );
    const now = Date.now();
    for (const mod of bundled) {
      stmt.run(mod.name, mod.manifest.version, selectedNames.includes(mod.name) ? 1 : 0, now, now);
    }
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// Main wizard
// ---------------------------------------------------------------------------

export async function run(): Promise<void> {
  const home = homeDir();
  mkdirSync(home, { recursive: true });
  const existing = loadConfig(home);
  const ramBytes = totalmem();
  const cpuCount = cpus().length;
  const tierGuess = detectTier(ramBytes, cpuCount);
  const ramGb = (ramBytes / 1024 / 1024 / 1024).toFixed(1);

  process.stdout.write(`Welcome to Modulus. Config will live in ${home}.\n\n`);

  // -- Web-first setup ---------------------------------------------------
  // Offer the browser wizard first. `modulus start` on an unconfigured install
  // serves the wizard, opens the browser itself, and promotes to the full
  // daemon once you finish — so init just hands off to it. Saying no continues
  // with the terminal wizard below.
  const bundled = discoverBundledModules();
  if (process.stdin.isTTY && process.stdout.isTTY) {
    const wantWeb = await confirm({
      message: 'Set Modulus up in your browser? Everything you can do here, but friendlier.',
      default: true,
    });
    if (wantWeb) {
      const { run: startRun } = await import('./start.js');
      await startRun({});
      return;
    }
    process.stdout.write('Continuing setup in the terminal.\n\n');
  }

  // -- Telegram ----------------------------------------------------------
  let token = existing.telegram.token;
  let botUsername: string | undefined;
  for (;;) {
    token = await password({
      message: 'Telegram bot token (from @BotFather):',
      mask: '*',
      validate: (v) => (v.trim().length > 0 ? true : 'Required.'),
    });
    process.stdout.write('Validating with Telegram… ');
    const info = await validateBotToken(token.trim());
    if (info.ok) {
      botUsername = info.username;
      process.stdout.write(`✓ Connected as @${botUsername ?? '<unknown>'}.\n`);
      break;
    }
    process.stdout.write('✗ token rejected.\n');
    const retry = await confirm({ message: 'Try a different token?', default: true });
    if (!retry) break;
  }

  const allowedRaw = await input({
    message: 'Allowed Telegram user IDs (comma-separated):',
    default: existing.telegram.allowedIds.join(','),
    validate: (v) => {
      try {
        const ids = parseAllowedIds(v);
        return ids.length > 0 ? true : 'Need at least one numeric Telegram user id.';
      } catch (e) {
        return (e as Error).message;
      }
    },
  });
  const allowedIds = parseAllowedIds(allowedRaw);

  // -- Ollama ------------------------------------------------------------
  const ollamaUrl = await input({
    message: 'Ollama URL:',
    default: existing.ollama.url,
  });
  process.stdout.write('Probing Ollama… ');
  const probe = await probeOllama(ollamaUrl);
  let chatModel = existing.models.chat;
  let reasonModel: string | undefined = existing.models.reason;
  let toolsModel: string | undefined = existing.models.tools;
  const modelTags = availableModelTags(probe.ok ? probe.models : [], home);
  if (!probe.ok) {
    process.stdout.write(`✗ ${probe.error ?? 'unreachable'}.\n`);
    process.stdout.write(
      'Continuing with defaults; you can run `modulus models` later once Ollama is up.\n',
    );
  }
  if (modelTags.length > 0) {
    if (probe.ok) process.stdout.write(`✓ ${probe.models.length} Ollama models available.\n`);
    else process.stdout.write('Enabled module model options available.\n');

    const chatChoices = [
      ...modelTags.map((m) => ({ name: m, value: m })),
      { name: '(enter a model name manually)', value: '__custom__' },
    ];
    const chatPick = await select({
      message: 'Chat profile model:',
      choices: chatChoices,
      default: modelTags.includes(existing.models.chat) ? existing.models.chat : modelTags[0],
    });
    chatModel =
      chatPick === '__custom__'
        ? await input({ message: 'Chat model tag:', default: existing.models.chat })
        : chatPick;

    const reasonChoices = [
      { name: '(skip — small device)', value: '__skip__' },
      ...modelTags.map((m) => ({ name: m, value: m })),
      { name: '(enter a model name manually)', value: '__custom__' },
    ];
    const reasonPick = await select({
      message: 'Reasoning profile model:',
      choices: reasonChoices,
      default: existing.models.reason ?? '__skip__',
    });
    if (reasonPick === '__skip__') reasonModel = undefined;
    else if (reasonPick === '__custom__') {
      reasonModel = await input({ message: 'Reasoning model tag:' });
    } else reasonModel = reasonPick;

    const toolsChoices = [
      { name: '(skip — reuse chat model for tool turns)', value: '__skip__' },
      ...modelTags.map((m) => ({ name: m, value: m })),
      { name: '(enter a model name manually)', value: '__custom__' },
    ];
    const toolsPick = await select({
      message: 'Tool-use profile model (handles every tool-bearing turn):',
      choices: toolsChoices,
      default: existing.models.tools ?? '__skip__',
    });
    if (toolsPick === '__skip__') toolsModel = undefined;
    else if (toolsPick === '__custom__') {
      toolsModel = await input({ message: 'Tool-use model tag:' });
    } else toolsModel = toolsPick;
  }

  // -- Tier --------------------------------------------------------------
  // Show what Modulus actually saw — under WSL2 / Docker the reported RAM is
  // the container cap, not host RAM, so the user can spot a mismatch and
  // override.
  process.stdout.write(`\nDetected: ${ramGb} GB RAM, ${cpuCount} logical CPU(s).\n`);
  const tier = (await select({
    message: `Hardware tier (suggested: ${tierGuess}):`,
    choices: [
      { name: 'small (Pi 4/5, 4–8GB)', value: 'small' },
      { name: 'standard (mini PC, 16GB)', value: 'standard' },
      { name: 'heavy (5800H+, 32GB)', value: 'heavy' },
    ],
    default: existing.tier ?? tierGuess,
  })) as ModulusConfig['tier'];

  const cfg: ModulusConfig = {
    telegram: { token: token.trim(), allowedIds },
    ollama: { url: ollamaUrl.trim() },
    models: {
      chat: chatModel,
      ...(reasonModel ? { reason: reasonModel } : {}),
      ...(toolsModel ? { tools: toolsModel } : {}),
    },
    ...(tier ? { tier } : {}),
    logLevel: existing.logLevel ?? 'info',
  };
  saveConfig(cfg, home);
  process.stdout.write(`\n✓ Wrote ${home}/config.json.\n`);

  // Read effective config so we can warn if env overrides are about to win.
  const effective = effectiveConfig(home);
  if (effective.telegram.token !== cfg.telegram.token) {
    process.stdout.write(
      'Note: TELEGRAM_BOT_TOKEN in your environment overrides the config file.\n',
    );
  }

  // -- Modules --------------------------------------------------------
  if (bundled.length === 0) {
    process.stdout.write('\nNo bundled modules found — run `modulus start` to launch.\n');
    return;
  }

  process.stdout.write('\n');
  const selectedNames = await checkbox({
    message: 'Select modules to enable (Space to toggle, Enter to confirm):',
    choices: bundled.map((mod) => ({
      name: `${mod.name}${mod.manifest.description ? '  —  ' + mod.manifest.description : ''}`,
      value: mod.name,
    })),
  });

  const selection = resolveModuleSelection(bundled, selectedNames);
  const selected = selection.modules;
  if (selection.addedDependencies.length > 0) {
    process.stdout.write(
      `\nAlso enabling required module${selection.addedDependencies.length === 1 ? '' : 's'}: ${selection.addedDependencies.join(', ')}\n`,
    );
  }
  for (const missing of selection.missingDependencies) {
    process.stdout.write(
      `\nWarning: ${missing.module} depends on ${missing.dependency}, but it is not bundled here. Install it before starting Modulus.\n`,
    );
  }

  // Pre-seed module_state so unselected bundled modules are disabled
  // from the first start rather than auto-enabled by the loader.
  presetModuleStates(
    home,
    bundled,
    selected.map((mod) => mod.name),
  );

  if (selected.length === 0) {
    process.stdout.write(
      '\nNo modules selected. You can add them later with:\n' +
        '  modulus mod install <name>   — install a module\n' +
        '  modulus auth <module>     — run a module OAuth flow\n' +
        '  modulus config               — edit settings interactively\n\n' +
        'Run `modulus start` to launch.\n',
    );
    return;
  }

  await setupModules(home, selected);
  printTelegramCommandsGuide(selected, botUsername);

  process.stdout.write('\nAll done. Run `modulus start` to launch.\n');
}
