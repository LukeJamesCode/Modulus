// `modulus stop` — stop a running daemon and the web panel.
//
// Reads the PID from ~/.modulus/modulus.pid (written by `modulus start`) and
// sends SIGTERM. The bot's signal handler does an orderly shutdown that also
// removes the pid file. Also stops the modulus-frontend web panel (and any
// orphan panel process still holding its port), unless --agent-only is passed.

import { homeDir } from './config-store.js';
import { clearPid, isAlive, readPid } from './daemon.js';
import { killPanel } from './panel.js';

export interface StopRunOptions {
  // Leave the modulus-frontend web panel running. Used by the panel itself
  // when its Stop button calls /api/agent/stop — otherwise that click
  // would kill the very UI making the request.
  agentOnly?: boolean;
}

export async function run(options: StopRunOptions = {}): Promise<void> {
  const home = homeDir();
  stopAgent(home);
  if (!options.agentOnly) killPanel(home);
}

function stopAgent(home: string): void {
  const pid = readPid(home);
  if (pid === null) {
    process.stdout.write('No PID file — modulus does not appear to be running.\n');
    return;
  }
  if (!isAlive(pid)) {
    process.stdout.write(`Stale PID file (pid ${pid} is not alive). Cleaning up.\n`);
    clearPid(home);
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
    process.stdout.write(`Sent SIGTERM to pid ${pid}.\n`);
  } catch (e) {
    process.stderr.write(`Failed to signal pid ${pid}: ${(e as Error).message}\n`);
    process.exit(1);
  }
}
