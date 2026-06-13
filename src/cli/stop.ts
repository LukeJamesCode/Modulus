// `modulus stop` — stop a running daemon.
//
// Reads the PID from ~/.modulus/modulus.pid (written by `modulus start`) and
// sends SIGTERM. The bot's signal handler does an orderly shutdown that also
// removes the pid file and closes the in-process web panel. On Windows
// SIGTERM is a hard kill (no handler runs), so we first try the panel's
// graceful POST /api/agent/stop and only fall back to the signal.

import { readFileSync } from 'node:fs';
import { effectiveConfig, homeDir } from './config-store.js';
import { clearPid, isAlive, panelTokenPath, readPid } from './daemon.js';

export async function run(): Promise<void> {
  await stopAgent(homeDir());
}

async function stopAgent(home: string): Promise<void> {
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

  if (process.platform === 'win32' && (await stopViaPanel(home, pid))) return;

  try {
    process.kill(pid, 'SIGTERM');
    process.stdout.write(`Sent SIGTERM to pid ${pid}.\n`);
  } catch (e) {
    process.stderr.write(`Failed to signal pid ${pid}: ${(e as Error).message}\n`);
    process.exit(1);
  }
}

// Ask the running daemon to shut itself down over the panel API. Returns true
// only once the process is actually gone; any failure falls back to SIGTERM.
async function stopViaPanel(home: string, pid: number): Promise<boolean> {
  let token: string;
  try {
    token = readFileSync(panelTokenPath(home), 'utf8').trim();
  } catch {
    return false;
  }
  if (!token) return false;

  let port: number;
  let bind: string;
  try {
    const cfg = effectiveConfig(home);
    if (cfg.panel?.enabled === false) return false;
    port = cfg.panel?.port ?? 7777;
    bind = cfg.panel?.bind ?? '127.0.0.1';
  } catch {
    return false;
  }

  const host = bind === '0.0.0.0' ? '127.0.0.1' : bind;
  try {
    const res = await fetch(`http://${host}:${port}/api/agent/stop`, {
      method: 'POST',
      headers: { 'x-modulus-token': token },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return false;
  } catch {
    return false;
  }

  // The daemon's own shutdown has an 8s hard-exit budget; give it 12.
  process.stdout.write(`Asked pid ${pid} to stop via the panel…\n`);
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) {
      process.stdout.write('Stopped.\n');
      return true;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  process.stdout.write('Graceful stop timed out; falling back to a signal.\n');
  return false;
}
