// Helpers for the modulus-frontend web panel — spawn, kill, URL.
//
// The panel runs as a separate process from the agent daemon so the panel's
// Start/Stop buttons can drive `modulus start` / `modulus stop` without taking
// the UI down with them. Used by start.ts (spawn + print URL), stop.ts (kill
// + clean up orphans), and init.ts (web setup handoff).

import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { open as openDb, type DB } from '../storage/db.js';
import { createLogger } from '../util/log.js';
import { frontendLogFilePath, frontendPidFilePath, isAlive } from './daemon.js';

const EXT_NAME = 'modulus-frontend';

interface PanelSettings {
  host: string;
  port: number;
  token: string;
  httpsEnabled: boolean;
}

function readPanelSettings(home: string): PanelSettings {
  const dbPath = join(home, 'modulus.db');
  const fallback: PanelSettings = {
    host: '127.0.0.1',
    port: 7777,
    token: '',
    httpsEnabled: true,
  };
  if (!existsSync(dbPath)) return fallback;
  let db: DB | null = null;
  try {
    db = openDb({ path: dbPath, log: createLogger({ level: 'warn' }) });
    const rows = db
      .prepare(`SELECT key, value FROM extension_settings WHERE extension = ?`)
      .all(EXT_NAME) as Array<{ key: string; value: string }>;
    const settings = new Map(rows.map((r) => [r.key, r.value]));
    const port = Number(settings.get('listen_port'));
    return {
      host: settings.get('listen_host') || fallback.host,
      port: Number.isFinite(port) && port > 0 ? port : fallback.port,
      token: settings.get('auth_token') || '',
      // Mirror extensions/modulus-frontend/server.ts: only explicit 'false' opts out.
      httpsEnabled: settings.get('https_enabled') !== 'false',
    };
  } catch {
    return fallback;
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

function firstLanAddress(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return null;
}

// URL the user can open to reach the panel — or null if the panel can't be
// reached over the network yet (no token + bound non-loopback would 401).
export function panelUrl(home: string): string | null {
  const s = readPanelSettings(home);
  const shownHost = s.host === '0.0.0.0' ? (firstLanAddress() ?? 'localhost') : s.host;
  const scheme = s.httpsEnabled ? 'https' : 'http';
  const tokenQs = s.token ? `?token=${encodeURIComponent(s.token)}` : '';
  return `${scheme}://${shownHost}:${s.port}/${tokenQs}`;
}

// True when a frontend pidfile names a live process.
export function panelRunning(home: string): boolean {
  const pid = readPanelPid(home);
  return pid !== null && isAlive(pid);
}

function readPanelPid(home: string): number | null {
  const file = frontendPidFilePath(home);
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, 'utf8').trim();
    // Reject partial garbage (e.g. "12abc") that parseInt would truncate to 12.
    if (!/^\d+$/.test(raw)) return null;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function clearPanelPid(home: string): void {
  const file = frontendPidFilePath(home);
  try {
    if (existsSync(file)) unlinkSync(file);
  } catch {
    /* ignore */
  }
}

// Find PIDs holding the panel's listen port that aren't tracked by the pidfile.
// Best-effort: requires `lsof` (Linux / macOS). On systems without it we just
// return an empty list — `modulus stop` then falls back to the pidfile alone.
function orphanPanelPids(port: number, knownPid: number | null): number[] {
  let out: string;
  try {
    const r = spawnSync('lsof', ['-tiTCP:' + port, '-sTCP:LISTEN'], { encoding: 'utf8' });
    if (r.status !== 0 && r.status !== 1) return []; // 1 = no matches
    out = String(r.stdout ?? '');
  } catch {
    return [];
  }
  return out
    .split(/\s+/)
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => Number.isFinite(n) && n > 0 && n !== knownPid);
}

// Spawn `modulus __panel` (hidden internal command) as a sibling background
// process so killing the foreground agent doesn't take the panel with it.
// Best-effort: a failure is surfaced on stderr but doesn't break the caller.
export function spawnPanel(home: string): void {
  if (panelRunning(home)) return;
  const here = dirname(fileURLToPath(import.meta.url));
  const cliEntry = process.argv[1] ?? join(here, 'index.js');
  try {
    // Capture the panel's stdout/stderr in a log file rather than discarding
    // them. The panel runs detached, and the Tudor course builder runs inside
    // it, so without this its logs (e.g. a generator falling back to local)
    // would be invisible — `modulus start`'s terminal only sees the agent
    // daemon. `modulus logs --panel` tails this file.
    const logFile = frontendLogFilePath(home);
    let outFd: number;
    try {
      mkdirSync(dirname(logFile), { recursive: true, mode: 0o700 });
      outFd = openSync(logFile, 'a', 0o600);
    } catch {
      outFd = -1; // fall back to discarding if the log file can't be opened
    }
    const stdio: ['ignore', number | 'ignore', number | 'ignore'] =
      outFd >= 0 ? ['ignore', outFd, outFd] : ['ignore', 'ignore', 'ignore'];
    const child = spawn(process.execPath, [...process.execArgv, cliEntry, '__panel'], {
      detached: true,
      stdio,
      env: process.env,
    });
    child.unref();
    // The child inherited its own copy of the fd; close ours so we don't leak it.
    if (outFd >= 0) {
      try {
        closeSync(outFd);
      } catch {
        /* ignore */
      }
    }
  } catch (e) {
    process.stderr.write(
      `modulus-frontend failed to start: ${e instanceof Error ? e.message : String(e)}\n`,
    );
  }
}

// Stop the panel: SIGTERM the pid named in the pidfile, then SIGTERM any other
// process still holding the panel's port (orphans from earlier crashes that
// the pidfile lost track of). Returns true if anything was killed.
export function killPanel(home: string): boolean {
  let killed = false;
  const pid = readPanelPid(home);
  if (pid !== null && isAlive(pid)) {
    try {
      process.kill(pid, 'SIGTERM');
      process.stdout.write(`modulus-frontend stopped (pid ${pid}).\n`);
      killed = true;
    } catch (e) {
      process.stderr.write(
        `Failed to stop modulus-frontend (pid ${pid}): ${(e as Error).message}\n`,
      );
    }
  }
  clearPanelPid(home);

  const { port } = readPanelSettings(home);
  for (const orphan of orphanPanelPids(port, pid)) {
    try {
      process.kill(orphan, 'SIGTERM');
      process.stdout.write(`Killed orphan panel on port ${port} (pid ${orphan}).\n`);
      killed = true;
    } catch {
      /* race: the process exited between lsof and kill — that's fine */
    }
  }
  return killed;
}

// Take over the panel pidfile for the current process — used by the in-process
// panel runner (`modulus __panel`) before importing the server module.
export function acquirePanelPid(home: string): boolean {
  const file = frontendPidFilePath(home);
  // Mirror daemon.tryAcquirePidLock: the 'wx' open flag makes the create-or-fail
  // atomic, closing the read-then-write race where two panels both see an empty
  // pidfile and both claim it.
  try {
    writeFileSync(file, String(process.pid), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return false;
  }
  // The file already exists. If it names a live process we lost the race; if
  // it's stale (dead pid), clear it and retry the exclusive write once.
  const existing = readPanelPid(home);
  if (existing !== null && isAlive(existing)) return false;
  clearPanelPid(home);
  try {
    writeFileSync(file, String(process.pid), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

// Release the pidfile if it still names us. Avoids stomping on a successor
// process that took over after we crashed.
export function releasePanelPid(home: string): void {
  if (readPanelPid(home) === process.pid) clearPanelPid(home);
}
