// `modulus auth <module>` — runs auth flows declared by modules.
//
// The flow lives in <module>/auth.ts and registers itself with `host.auth.flow`.
// Here we set up just enough host plumbing to import that file, run the
// declared flow with a real I/O stub (terminal prompts), and write the
// returned settings into the module_settings table.

import { input, password } from '@inquirer/prompts';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { moduleFolders } from './module-paths.js';
import { open as openDb, type DB } from '../storage/db.js';
import { createLogger } from '../util/log.js';
import type { AuthFlow, AuthFlowIO, Host, Manifest } from '../core/modules.js';
import { createModuleTripwires } from '../core/module-tripwires.js';
import { homeDir } from './config-store.js';
import { fetchBotUsername, printTelegramCommandsGuide } from './ext-setup.js';

export interface DiscoveredModule {
  name: string;
  folder: string;
  manifest: Manifest;
}

export function discover(home: string, name: string): DiscoveredModule | null {
  for (const { folder } of moduleFolders(home)) {
    try {
      const manifestPath = join(folder, 'manifest.json');
      if (!existsSync(manifestPath)) continue;
      const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
      if (m.name === name) return { name: m.name, folder, manifest: m };
    } catch {
      /* ignore */
    }
  }
  return null;
}

// Core auth runner. Takes an already-open DB so it can be called from both
// `modulus auth` (which opens its own DB) and `modulus init` (shared DB session).
export interface AuthRunnerIO extends AuthFlowIO {
  announce?: (line: string) => void;
}

export async function runAuthForModule(
  mod: DiscoveredModule,
  db: DB,
  ioOverride?: AuthRunnerIO,
): Promise<void> {
  const authEntry = mod.manifest.entrypoints?.auth;
  if (!authEntry) throw new Error(`'${mod.name}' has no auth entrypoint`);

  const log = createLogger({ level: 'warn' });
  const dataDir = join(homeDir(), 'module_state', mod.name);
  mkdirSync(dataDir, { recursive: true });

  // The auth flow runs the module's own code, so it gets the same tripwire-
  // enforced gateways the loader hands a running module — an OAuth fetch the
  // module didn't declare is denied here too.
  const tripwires = createModuleTripwires({
    moduleName: mod.name,
    permissions: mod.manifest.permissions ?? {},
    dataDir,
    log,
    onDenied: () => {},
  });

  let captured: AuthFlow | null = null;
  const host: Host = {
    name: mod.name,
    version: mod.manifest.version,
    log,
    dataDir,
    db,
    fetch: tripwires.fetch,
    spawn: tripwires.spawn,
    fs: tripwires.fs,
    llm: {
      chat() {
        throw new Error('llm not available during auth');
      },
      async health() {
        return { ok: false, models: [] };
      },
      listProfiles() {
        return { chat: null, reason: null, tools: null };
      },
      resolveModel() {
        throw new Error('llm not available during auth');
      },
      breakerSnapshot: () => ({
        state: 'closed',
        failures: 0,
        consecutiveSuccesses: 0,
        openedAt: null,
        retryAt: null,
      }),
      stopIdleEviction: () => {},
    },
    settings: {
      get: () => undefined as never,
      set: () => {},
      all: () => ({}),
    },
    tools: {
      register: () => {},
      unregister: () => {},
      onAfterExecute: () => {},
    },
    telegram: {
      command: () => {},
      intercept: () => {},
      afterReply: () => {},
      afterTurn: () => {},
      sendVoice: async () => {},
      onVoiceMessage: () => {},
      defaultChatId: 0,
      chatId: 0,
      knownChats: () => [],
      onCallback: () => {},
    },
    scheduler: { cron: () => {}, cronMatches: () => false },
    cache: {
      get: () => undefined,
      set: () => {},
      delete: () => {},
      clear: () => {},
      stats: () => ({ hits: 0, misses: 0, size: 0 }),
    },
    prompts: { contribute: () => {} },
    guards: { register: () => () => {} },
    auth: {
      flow: (f) => {
        captured = f;
      },
    },
    chat: {
      // `modulus auth` only imports auth.ts to capture the AuthFlow; no
      // chat surface should register itself here. No-ops keep the Host
      // structurally complete without ever delivering a fake confirm prompt
      // or running a real turn.
      registerConfirm: () => {},
      dispatchInbound: async () => {},
    },
  };

  const abs = resolve(mod.folder, authEntry);
  const url = pathToFileURL(abs).href;
  const loaded = (await import(url)) as { register?: (host: Host) => void | Promise<void> };
  if (typeof loaded.register !== 'function') {
    throw new Error(`'${mod.name}/${authEntry}' has no register() export`);
  }
  await loaded.register(host);
  if (!captured) throw new Error(`'${mod.name}' did not call host.auth.flow()`);

  const flow = captured as AuthFlow;
  const announce = ioOverride?.announce ?? ((line: string) => process.stdout.write(line + '\n'));
  announce(`  Auth: ${flow.label}`);

  const io: AuthFlowIO = ioOverride ?? {
    print: (line) => process.stdout.write(line + (line.endsWith('\n') ? '' : '\n')),
    prompt: async (q, o) => {
      if (o?.secret) return await password({ message: `  ${q}`, mask: '*' });
      return await input({ message: `  ${q}` });
    },
  };

  const result = await flow.run(io);

  const insert = db.prepare(
    `INSERT INTO module_settings (module, key, value, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(module, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  const tx = db.transaction((entries: Array<[string, string | number | boolean]>) => {
    const now = Date.now();
    for (const [k, v] of entries) insert.run(mod.name, k, String(v), now);
  });
  tx(Object.entries(result));
  announce(`  ✓ Auth saved (${Object.keys(result).length} settings).`);
}

export async function run(moduleName: string | undefined): Promise<void> {
  if (!moduleName) {
    process.stderr.write('Usage: modulus auth <module-name>\n');
    process.exit(2);
  }
  const home = homeDir();
  const mod = discover(home, moduleName);
  if (!mod) {
    process.stderr.write(`Module '${moduleName}' not found in ${home}/modules or repo modules/.\n`);
    process.exit(1);
  }
  if (!mod.manifest.entrypoints?.auth) {
    process.stderr.write(`'${moduleName}' does not declare an auth entrypoint.\n`);
    process.exit(1);
  }

  const log = createLogger({ level: 'warn' });
  const db = openDb({ path: join(home, 'modulus.db'), log });
  try {
    process.stdout.write(`Running auth flow for '${moduleName}'.\n\n`);
    await runAuthForModule(mod, db);
  } catch (e) {
    process.stderr.write(`Auth failed: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }

  // Remind the user about any new slash commands this module declares so
  // they remember to register them with @BotFather. Skipped silently when the
  // module exposes no commands.
  const botUsername = await fetchBotUsername();
  printTelegramCommandsGuide([mod], botUsername, { includeCore: false });
}
