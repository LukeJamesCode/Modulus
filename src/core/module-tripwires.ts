// Module runtime tripwires — cheap in-process enforcement of the permissions
// block a module declared at install (network / subprocess / filesystem).
//
// These are TRIPWIRES, not a sandbox (blueprint §7): they enforce the declared
// allowlist for a module that reaches the outside world through the host-
// provided wrappers (host.fetch / host.spawn / host.fs), so the consent screen
// is truthful and accidental drift fails loud. A determined malicious module can
// still bypass them by importing node:fetch / node:child_process / node:fs
// directly — which is exactly why the registry stays curated and SECURITY.md
// keeps "only install modules you trust; skills are the safe tier". The point is
// to catch the honest mistake (a module that declared one host and then called
// another) and make the deny visible (the denied counter in /status + System).

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import type { Logger } from '../util/log.js';
import type { ModulePermissions } from './installer.js';

export class TripwireError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TripwireError';
  }
}

export type TripwireSurface = 'network' | 'subprocess' | 'filesystem';

// Reduce an allowlist entry (or a target) to a bare lowercase host. Tolerates a
// full URL or a host:port so a module can declare `https://api.example.com/v1`
// or `api.example.com:443` and still match cleanly.
function normalizeHost(entry: string): string {
  let e = entry.trim().toLowerCase();
  if (e === '*') return '*';
  if (e.includes('://')) {
    try {
      e = new URL(e).hostname;
    } catch {
      /* fall through to the manual strip */
    }
  }
  return e.replace(/:\d+$/, '').replace(/\/.*$/, '');
}

// Network host matching. '*' = any host. Otherwise an entry matches the target
// host exactly, or as a PARENT domain — `example.com` matches `api.example.com`
// but not `notexample.com` (the dot boundary is required). Suffix matching is
// the least-surprising reading of "this module contacts example.com".
export function hostMatchesAllowlist(host: string, allow: readonly string[]): boolean {
  const h = normalizeHost(host);
  if (!h) return false;
  for (const raw of allow) {
    const entry = normalizeHost(raw);
    if (entry === '*') return true;
    if (!entry) continue;
    if (h === entry || h.endsWith(`.${entry}`)) return true;
  }
  return false;
}

// Subprocess matching. The allowlist holds binary names; a command matches if
// its basename (sans a Windows .exe) equals an allowlisted entry's basename.
// '*' = any binary.
export function binaryAllowed(command: string, allow: readonly string[]): boolean {
  const norm = (s: string): string =>
    basename(s)
      .toLowerCase()
      .replace(/\.exe$/, '');
  const cmd = norm(command);
  for (const raw of allow) {
    if (raw.trim() === '*') return true;
    if (cmd === norm(raw)) return true;
  }
  return false;
}

// Lexical containment: `target` resolves to (or under) at least one allowed
// root. Tripwire level, not realpath — a symlink out of the root is the kind of
// thing only a malicious module would plant, and the threat model already says
// tripwires don't contain those.
export function pathContained(target: string, roots: readonly string[]): boolean {
  const abs = resolve(target);
  for (const root of roots) {
    const r = resolve(root);
    if (abs === r) return true;
    const rel = relative(r, abs);
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return true;
  }
  return false;
}

export interface ModuleFs {
  readFile(path: string): Promise<Buffer>;
  readTextFile(path: string): Promise<string>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  appendFile(path: string, data: string | Uint8Array): Promise<void>;
  readdir(path: string): Promise<string[]>;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
  rm(path: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void>;
  stat(path: string): Promise<import('node:fs').Stats>;
  exists(path: string): boolean;
  // The roots this facade is pinned to: the module's private dataDir plus any
  // consented filesystem roots.
  roots(): string[];
}

export interface ModuleTripwires {
  fetch: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>;
  spawn: (command: string, args?: readonly string[], options?: SpawnOptions) => ChildProcess;
  fs: ModuleFs;
}

export interface TripwireDeps {
  moduleName: string;
  permissions: ModulePermissions;
  // The module's private scratch dir — always an allowed filesystem root.
  dataDir: string;
  log: Logger;
  // Called once per blocked attempt, surfaced as the denied counter.
  onDenied: (surface: TripwireSurface) => void;
}

export function createModuleTripwires(deps: TripwireDeps): ModuleTripwires {
  const { moduleName, permissions, dataDir, log, onDenied } = deps;
  const network = permissions.network ?? [];
  const subprocess = permissions.subprocess ?? [];
  const fsRoots = [resolve(dataDir), ...(permissions.filesystem ?? []).map((p) => resolve(p))];

  function deny(surface: TripwireSurface, message: string): never {
    log.error('module tripwire blocked a call', { module: moduleName, surface, reason: message });
    onDenied(surface);
    throw new TripwireError(`[${moduleName}] ${surface} not permitted: ${message}`);
  }

  function checkPath(path: string): string {
    const abs = isAbsolute(path) ? resolve(path) : resolve(dataDir, path);
    if (!pathContained(abs, fsRoots)) {
      deny('filesystem', `${abs} is outside the module's allowed roots`);
    }
    return abs;
  }

  return {
    // async so a blocked host REJECTS rather than throwing synchronously —
    // fetch-like APIs never throw before returning a promise, and `await
    // host.fetch(bad)` should reject the same as any failed request.
    fetch: async (input, init) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request).url;
      let host: string;
      try {
        host = new URL(url).hostname;
      } catch {
        return deny('network', `invalid URL: ${String(url)}`);
      }
      if (!hostMatchesAllowlist(host, network)) {
        deny('network', `${host} is not in the module's network allowlist`);
      }
      return fetch(input, init);
    },
    // Synchronous, like child_process.spawn itself: a blocked binary throws.
    spawn: (command, args = [], options = {}) => {
      if (!binaryAllowed(command, subprocess)) {
        deny('subprocess', `${command} is not in the module's subprocess allowlist`);
      }
      return nodeSpawn(command, [...args], options);
    },
    // async wrappers so a blocked path rejects (checkPath throws); exists is the
    // one sync method, and a probe outside the roots throws to deny even reads.
    fs: {
      readFile: async (p) => fsp.readFile(checkPath(p)),
      readTextFile: async (p) => fsp.readFile(checkPath(p), 'utf8'),
      writeFile: async (p, data) => fsp.writeFile(checkPath(p), data),
      appendFile: async (p, data) => fsp.appendFile(checkPath(p), data),
      readdir: async (p) => fsp.readdir(checkPath(p)),
      mkdir: async (p, opts) => {
        await fsp.mkdir(checkPath(p), opts);
      },
      rm: async (p, opts) => fsp.rm(checkPath(p), opts),
      stat: async (p) => fsp.stat(checkPath(p)),
      exists: (p) => existsSync(checkPath(p)),
      roots: () => [...fsRoots],
    },
  };
}
