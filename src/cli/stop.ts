// `modulus stop` — stop a running daemon.
//
// Reads the PID from ~/.modulus/modulus.pid (written by `modulus start`) and
// sends SIGTERM. The bot's signal handler does an orderly shutdown that also
// removes the pid file and closes the in-process web panel.

import { homeDir } from './config-store.js';
import { clearPid, isAlive, readPid } from './daemon.js';

export async function run(): Promise<void> {
  stopAgent(homeDir());
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
