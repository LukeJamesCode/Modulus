// Marketplace routes: browse the curated registry and install from it, with a
// permission consent gate. This is the in-process, .tgz half of the Modules tab
// (the older CLI-spawn install in modules.ts stays for local-folder/git installs
// that developers use).
//
// Install is one atomic, fail-closed call rather than a stateful stage/commit
// dance, because the permissions a user consents to ARE the index entry's
// declared permissions (stageModule sets staged.permissions = entry.permissions),
// so a separate "stage then reveal real permissions" step would show nothing new.
// Re-consent is enforced by diffing against a per-module consent sidecar written
// at install time: any ADDED capability (including every capability on a first
// install) returns 409 needsConsent until the caller re-POSTs with acceptAdded,
// so the browser consent screen is mandatory before a capability is ever granted.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  stageModule,
  commitModule,
  discardStage,
  permissionDiff,
  describePermissions,
  hasPermissions,
  InstallError,
  type ModulePermissions,
  type FetchLike,
} from '../../core/installer.js';
import { fetchRegistryIndex, findRegistryEntry, registryUrl } from '../../core/registry.js';
import { collectModuleReadiness } from '../../core/module-readiness.js';
import { userModulesRoot } from '../../cli/module-paths.js';
import { ensurePrivateDir } from '../../cli/config-store.js';
import { readJson, sendJson } from '../http.js';
import type { RouteModule } from '../router.js';
import type { PanelDeps } from '../types.js';

// Best-effort core version for the entry's minCoreVersion gate; matches the
// version the panel reports in /api/state and package.json.
const HOST_VERSION = '1.0.0';
// Per-module record of the capabilities the user consented to, so an update
// that asks for MORE re-prompts while one that asks for the same (or less)
// installs quietly. Sits inside the module dir; the loader only reads
// manifest.json, so it's inert.
const CONSENT_SIDECAR = '.modulus-consent.json';

export interface MarketplaceOptions {
  // Injectable for tests/offline; defaults to global fetch.
  fetchImpl?: FetchLike;
  // Override the index URL; defaults to registryUrl() (MODULUS_REGISTRY_URL).
  registryUrl?: string;
}

function installedByName(deps: PanelDeps): Map<string, { version: string; folder: string }> {
  const out = new Map<string, { version: string; folder: string }>();
  for (const r of collectModuleReadiness(deps.moduleRoots, deps.db)) {
    out.set(r.name, { version: r.version, folder: r.folder });
  }
  return out;
}

function readConsent(folder: string): ModulePermissions {
  try {
    const raw = readFileSync(join(folder, CONSENT_SIDECAR), 'utf8');
    const o = JSON.parse(raw) as ModulePermissions;
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}

function writeConsent(dest: string, perms: ModulePermissions): void {
  try {
    writeFileSync(join(dest, CONSENT_SIDECAR), JSON.stringify(perms, null, 2));
  } catch {
    // Non-fatal: a missing sidecar just means the next update re-prompts for
    // consent, which is the safe direction.
  }
}

// a is strictly newer than b (semver major.minor.patch).
function isNewer(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

export interface BrowseResult {
  modules: Array<{
    name: string;
    displayName?: string;
    version: string;
    description?: string;
    docs?: string;
    permissions: string[];
    installed: boolean;
    installedVersion?: string;
    updateAvailable: boolean;
  }>;
  registryUrl: string;
}

// Fetch the index and decorate each entry with this install's state. Throws
// InstallError on a registry/transport problem (the caller maps it to 502 so
// the UI can distinguish "empty marketplace" from "registry unreachable").
export async function browseRegistry(
  deps: PanelDeps,
  opts: MarketplaceOptions = {},
): Promise<BrowseResult> {
  const url = opts.registryUrl ?? registryUrl();
  const entries = await fetchRegistryIndex({
    url,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  const installed = installedByName(deps);
  return {
    registryUrl: url,
    modules: entries.map((e) => {
      const have = installed.get(e.name);
      return {
        name: e.name,
        ...(e.displayName ? { displayName: e.displayName } : {}),
        version: e.version,
        ...(e.description ? { description: e.description } : {}),
        ...(e.docs ? { docs: e.docs } : {}),
        permissions: describePermissions(e.permissions ?? {}),
        installed: !!have,
        ...(have ? { installedVersion: have.version } : {}),
        updateAvailable: !!have && isNewer(e.version, have.version),
      };
    }),
  };
}

export interface InstallResult {
  status: number;
  body: Record<string, unknown>;
}

// Install (or update) a module from the registry. Fail-closed: an unknown name,
// a download/verify failure, or unconsented new capabilities all stop short of
// touching the live modules root.
export async function installFromRegistry(
  deps: PanelDeps,
  args: { name: string; acceptAdded?: boolean },
  opts: MarketplaceOptions = {},
): Promise<InstallResult> {
  const name = args.name.trim();
  if (!name) return { status: 400, body: { error: 'module name is required' } };

  let entry;
  try {
    const entries = await fetchRegistryIndex({
      ...(opts.registryUrl ? { url: opts.registryUrl } : {}),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
    entry = findRegistryEntry(entries, name);
  } catch (e) {
    return { status: 502, body: { error: e instanceof InstallError ? e.message : String(e) } };
  }
  if (!entry) return { status: 404, body: { error: `no module '${name}' in the registry` } };

  const installed = installedByName(deps);
  const have = installed.get(name);
  const wantPerms = entry.permissions ?? {};
  const priorConsent = have ? readConsent(have.folder) : {};
  const added = permissionDiff(priorConsent, wantPerms);

  // Mandatory consent for anything new (every capability on a first install).
  if (hasPermissions(added) && !args.acceptAdded) {
    return {
      status: 409,
      body: {
        needsConsent: true,
        name,
        version: entry.version,
        update: !!have,
        added: describePermissions(added),
        permissions: describePermissions(wantPerms),
      },
    };
  }

  const dest = userModulesRoot(deps.home);
  ensurePrivateDir(dest);
  let staged;
  try {
    staged = await stageModule(entry, {
      stagingRoot: join(deps.home, 'staging'),
      hostVersion: HOST_VERSION,
      log: deps.log,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
  } catch (e) {
    return { status: 400, body: { error: e instanceof InstallError ? e.message : String(e) } };
  }

  let committed: string;
  try {
    committed = commitModule(staged, dest, { replace: !!have });
  } catch (e) {
    discardStage(staged);
    return { status: 400, body: { error: e instanceof InstallError ? e.message : String(e) } };
  }
  writeConsent(committed, wantPerms);

  // Hot-load so the new module's tools/commands/agents appear without a restart.
  try {
    await deps.loader.reload(name);
  } catch (e) {
    return {
      status: 200,
      body: {
        ok: true,
        name,
        version: entry.version,
        warning: `installed but hot-reload failed: ${e instanceof Error ? e.message : String(e)} — restart Modulus to load it`,
      },
    };
  }

  deps.log.info('module installed from registry', { name, version: entry.version, update: !!have });
  return { status: 200, body: { ok: true, name, version: entry.version, update: !!have } };
}

export function createMarketplaceRoutes(
  deps: PanelDeps,
  opts: MarketplaceOptions = {},
): RouteModule {
  return async ({ req, res, path, method }) => {
    if (path === '/api/modules/registry' && method === 'GET') {
      try {
        sendJson(res, 200, await browseRegistry(deps, opts));
      } catch (e) {
        sendJson(res, 502, { error: e instanceof InstallError ? e.message : String(e) });
      }
      return true;
    }

    if (path === '/api/modules/registry/install' && method === 'POST') {
      const { name, acceptAdded } = await readJson<{ name?: string; acceptAdded?: boolean }>(req);
      const r = await installFromRegistry(
        deps,
        { name: name ?? '', acceptAdded: !!acceptAdded },
        opts,
      );
      sendJson(res, r.status, r.body);
      return true;
    }

    return false;
  };
}
