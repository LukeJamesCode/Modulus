// Setup-mode panel server. When `modulus start` runs on an unconfigured install
// there's no engine to borrow, so we boot the real in-process panel against a
// minimal real spine (DB + migrations, scheduler, prefs, hive memory) plus stub
// engine handles. The wizard's whole route surface works against this: state,
// config, ollama test/pull, telegram validate/pair, module list/enable/auth. On
// completion the CLI awaits `completed`, closes this server (releasing the port
// and DB), and boots the full daemon — see runSetupAndPromote in start.ts.

import { join } from 'node:path';
import { open as openDb, type DB } from '../storage/db.js';
import { createLogger } from '../util/log.js';
import { createScheduler } from '../core/scheduler.js';
import { createPrefsStore } from '../core/prefs.js';
import { setupMemory } from '../core/memory.js';
import { createToolRegistry } from '../core/tools.js';
import { createAgentRegistry } from '../core/agents.js';
import { createPanel, type PanelHandle } from '../panel/server.js';
import { createPanelConfirmBus } from '../panel/confirm-bus.js';
import { createPairingManager } from '../panel/telegram-pairing.js';
import type { PanelDeps } from '../panel/types.js';
import { effectiveConfig } from './config-store.js';
import { logFilePath } from './daemon.js';
import { defaultModuleRoots } from './start.js';

export interface SetupServer {
  handle: PanelHandle;
  // Resolves when the wizard POSTs /api/setup/complete and preflight passes.
  completed: Promise<void>;
  db: DB;
  // Stops pairing, closes the panel (destroying sockets so the port frees), and
  // closes the DB — all of which must finish before the full daemon rebinds.
  close(): Promise<void>;
}

export interface StartSetupOptions {
  // The previous failed-boot message, shown by the wizard as a banner on
  // re-entry after a promotion attempt threw.
  lastError?: string | null;
  // --lan override: bind the panel to 0.0.0.0 for this run only.
  bindOverride?: string;
  // The panel's Stop button calls this so the foreground CLI can exit cleanly.
  onStop(): void;
}

export async function startSetupServer(
  home: string,
  opts: StartSetupOptions,
): Promise<SetupServer> {
  const baseCfg = effectiveConfig(home);
  const config = opts.bindOverride
    ? { ...baseCfg, panel: { ...baseCfg.panel, bind: opts.bindOverride } }
    : baseCfg;

  const log = createLogger({ level: config.logLevel ?? 'info', file: logFilePath(home) });
  const db = openDb({ path: join(home, 'modulus.db'), log });

  const tools = createToolRegistry({ log, confirm: async () => false });
  const scheduler = createScheduler({
    log,
    dispatch: async () => {},
    prefs: createPrefsStore(db),
    db,
  });
  const memory = setupMemory({ db, tools, log });

  // Our own getUpdates-backed pairing manager (no adapter exists yet). Passing it
  // via deps.pairing means the setup routes drive it directly; close() stops its
  // long-poll so the full daemon's grammY poller doesn't collide with a 409.
  const pairing = createPairingManager({ db, log });

  let resolveCompleted!: () => void;
  const completed = new Promise<void>((resolve) => {
    resolveCompleted = resolve;
  });

  // Stub engine handles — the wizard view is pinned, so chat/agent routes are
  // never meant to be hit; if a stray call lands, the orchestrator stub answers
  // with a friendly message rather than a 500.
  const deps: PanelDeps = {
    db,
    log,
    home,
    config,
    moduleRoots: defaultModuleRoots(home),
    scheduler,
    agentRegistry: createAgentRegistry(db),
    agentQueue: { notify() {} } as unknown as PanelDeps['agentQueue'],
    agentRuntime: {
      subscribe: () => () => {},
    } as unknown as PanelDeps['agentRuntime'],
    llm: {
      resolveModel: () => config.models.chat,
      listProfiles: () => ({}),
      health: async () => ({ ok: false, models: [] }),
      providerModels: () => [],
    } as unknown as PanelDeps['llm'],
    memory,
    orchestrator: {
      handleUserMessage: async (msg: { send: (c: { delta: string; done: boolean }) => void }) => {
        msg.send({
          delta: 'Modulus is still being set up — finish the wizard first.',
          done: false,
        });
        msg.send({ delta: '', done: true });
      },
      stop: () => false,
      newChat: () => {},
      lastError: () => undefined,
      shutdown: async () => {},
    } as unknown as PanelDeps['orchestrator'],
    loader: {
      intercepts: () => [],
      commands: () => [],
      afterReplies: () => [],
      afterTurns: () => [],
      callbacks: () => [],
      voiceMessages: () => [],
      chatSurfaces: () => [],
      relevantModules: () => [],
      promptFragment: () => '',
      turnGuards: () => [],
      suspendReload: () => {},
      resumeReload: () => {},
      reload: async () => {},
      unload: async () => {},
    } as unknown as PanelDeps['loader'],
    confirmBus: createPanelConfirmBus(),
    pairing,
    setup: {
      complete: () => resolveCompleted(),
      lastError: () => opts.lastError ?? null,
    },
    onStop: () => opts.onStop(),
  };

  let handle: PanelHandle;
  try {
    handle = await createPanel(deps);
  } catch (err) {
    // createPanel can throw (e.g. EADDRINUSE on the configured port). Both the
    // pairing long-poll interval and the open DB would otherwise outlive this
    // function and keep the event loop alive, hanging the CLI / test process.
    pairing.stop();
    try {
      db.close();
    } catch {
      /* ignore */
    }
    throw err;
  }

  return {
    handle,
    completed,
    db,
    close: async () => {
      pairing.stop();
      try {
        await handle.close();
      } catch {
        /* ignore */
      }
      try {
        db.close();
      } catch {
        /* ignore */
      }
    },
  };
}
