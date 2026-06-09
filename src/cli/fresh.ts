// `modulus fresh` - wipe all local Modulus data, update the code, then re-run
// the setup wizard. Equivalent to: stop + rm -rf ~/.modulus + update + init.
//
// This is destructive and prompts for confirmation before proceeding.

import { confirm } from '@inquirer/prompts';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { homeDir } from './config-store.js';
import { isAlive, readPid } from './daemon.js';
import { killPanel } from './panel.js';
import { run as runUpdate } from './update.js';
import { run as runInit } from './init.js';

export interface FreshOptions {
  yes?: boolean;
  init?: boolean;
  stopPanel?: boolean;
}

export async function run(options: FreshOptions = {}): Promise<void> {
  const home = homeDir();
  const shouldRunInit = options.init !== false;
  const shouldStopPanel = options.stopPanel !== false;

  process.stdout.write(
    'Fresh install will erase all Modulus config, the database, logs, installed extensions,\n' +
      'and extension state, including Modulus-managed Piper binaries, ffmpeg paths, and voice\n' +
      `models${shouldStopPanel ? ', and will stop the web panel (killing any orphan still on its port)' : ''}.\n` +
      'Ollama models in ~/.ollama are NOT touched — re-pull only if you want to.\n' +
      `Data directory: ${home}\n\n`,
  );

  if (!options.yes) {
    const ok = await confirm({
      message: 'Are you sure? This cannot be undone.',
      default: false,
    });
    if (!ok) {
      process.stdout.write('Aborted.\n');
      return;
    }
  }

  // Stop a running daemon before wiping its home dir. Poll until it actually
  // exits rather than sleeping a flat interval — the daemon's shutdown budget
  // is several seconds, and wiping the DB/WAL/logs out from under a still-live
  // process can corrupt state or crash it mid-shutdown. SIGKILL after the
  // budget so a hung daemon doesn't leave us touching files it's still writing.
  const pid = readPid(home);
  if (pid && isAlive(pid)) {
    process.stdout.write(`Stopping running daemon (pid ${pid})...\n`);
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Already gone - fine.
    }
    const deadlineMs = Date.now() + 10_000;
    while (isAlive(pid) && Date.now() < deadlineMs) {
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
    }
    if (isAlive(pid)) {
      process.stdout.write(`Daemon (pid ${pid}) did not exit within 10s; sending SIGKILL.\n`);
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }

  // Kill the panel too — it's a separate process from the daemon, so the
  // SIGTERM above doesn't reach it. killPanel also reaps orphans still holding
  // the panel's port, which a previous crash can leave behind (the same
  // ERR_EMPTY_RESPONSE situation users hit when 'modulus stop' missed them).
  if (shouldStopPanel) {
    killPanel(home);
  } else {
    process.stdout.write('Leaving modulus-frontend running for browser setup handoff.\n');
  }

  process.stdout.write(`Wiping ${home}...\n`);
  rmSync(home, { recursive: true, force: true });
  process.stdout.write('Data directory cleared.\n\n');

  await runUpdate();

  if (!shouldRunInit) {
    process.stdout.write(
      '\nFresh wipe and update complete. Run `modulus init` to configure Modulus.\n',
    );
    return;
  }

  process.stdout.write('\n--- Running setup wizard ---\n\n');
  // Re-exec `init` in a FRESH process so it runs the code we just rebuilt, not
  // the stale modules this `modulus fresh` process loaded before `git pull`.
  // Without this, a self-update can't change the wizard it runs on the same go.
  const cliEntry = process.argv[1];
  if (cliEntry) {
    const res = spawnSync(process.execPath, [...process.execArgv, cliEntry, 'init'], {
      stdio: 'inherit',
    });
    process.exit(res.status ?? 0);
  }
  // Fallback (no resolvable entry script): run in-process.
  await runInit();
}
