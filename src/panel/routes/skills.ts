// Skills routes: the SAFE-tier half of the Modules tab. A skill is pure prompt
// data — a summary, a playbook, and an allowlist of tools the user already has.
// So this route family is deliberately thinner than the module one: there is no
// setup entrypoint, no settings schema, no SSE consent dance. Install is the one
// fail-closed call (stageSkill runs the code-free gate again before anything
// touches the live skills root), gated by a tool-based consent diff rather than
// a permission block. Enable/disable flips skill_state and reloads — the loader
// re-reads the row and either loads the playbook or stores a disabled stub.
//
// What the consent screen shows is the resolved per-tool tier ("uses web_search
// — runs automatically; add_event — asks you each time"), never a raw block,
// because a skill's only capability IS the union of those tools' tiers.

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  stageSkill,
  commitSkill,
  discardSkill,
  skillToolDiff,
  describeSkillTools,
  InstallError,
  type SkillToolTier,
  type FetchLike,
} from '../../core/installer.js';
import { fetchRegistryIndex, findRegistryEntry, registryUrl } from '../../core/registry.js';
import { ensurePrivateDir } from '../../cli/config-store.js';
import { readJson, sendJson } from '../http.js';
import { HOST_VERSION } from '../../core/version.js';
import type { RouteModule } from '../router.js';
import type { PanelDeps } from '../types.js';

// Per-skill record of the tools the user consented to, so an update asking for
// MORE re-prompts while one asking for the same (or fewer) installs quietly.
// Inert data beside the bundle — the loader only reads skill.json, and the
// code-free gate accepts .json, so it never executes and never trips the gate.
const SKILL_CONSENT_SIDECAR = '.modulus-skill-consent.json';

export interface SkillRoutesOptions {
  fetchImpl?: FetchLike;
  registryUrl?: string;
}

function userSkillsRoot(home: string): string {
  return join(home, 'skills');
}

function readSkillConsent(folder: string): string[] {
  try {
    const o = JSON.parse(readFileSync(join(folder, SKILL_CONSENT_SIDECAR), 'utf8')) as {
      tools?: unknown;
    };
    return Array.isArray(o.tools) ? o.tools.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

function writeSkillConsent(dest: string, tools: string[]): void {
  try {
    writeFileSync(join(dest, SKILL_CONSENT_SIDECAR), JSON.stringify({ tools }, null, 2));
  } catch {
    // Non-fatal: a missing sidecar just means the next update re-prompts, which
    // is the safe direction.
  }
}

// Resolve each tool name to its live tier and render the consent line. Pure
// over describeSkillTools so the panel and the install screen agree word-for-word.
function describeTiers(deps: PanelDeps, allowlist: readonly string[]): string[] {
  const tools = deps.skills?.tools;
  return describeSkillTools(
    allowlist.map((name) => ({
      name,
      tier: (tools?.get(name)?.tier ?? 'unknown') as SkillToolTier,
    })),
  );
}

function isNewer(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

export interface InstalledSkillView {
  name: string;
  version: string;
  enabled: boolean;
  summary: string;
  error?: string;
  tools: string[];
  agents: string[];
  playbook: string;
}

// The skills installed on this host, as the panel renders them.
export function listInstalledSkills(deps: PanelDeps): InstalledSkillView[] {
  const loader = deps.skills?.loader;
  if (!loader) return [];
  return loader.list().map((s) => ({
    name: s.name,
    version: s.version,
    enabled: s.enabled,
    summary: s.summary,
    ...(s.error ? { error: s.error } : {}),
    tools: describeTiers(deps, s.toolAllowlist),
    agents: s.registeredAgents,
    playbook: s.instructions,
  }));
}

// Enable/disable: flip the state row, then reload so the loader either loads the
// playbook (enable) or stores a disabled stub and drops the skill's personas
// (disable). Returns false for a name the host has never seen.
export async function setSkillEnabled(
  deps: PanelDeps,
  name: string,
  enabled: boolean,
): Promise<boolean> {
  const loader = deps.skills?.loader;
  if (!loader) return false;
  const info = deps.db
    .prepare(`UPDATE skill_state SET enabled = ? WHERE name = ?`)
    .run(enabled ? 1 : 0, name);
  if (info.changes === 0) return false;
  await loader.reload(name);
  deps.log.info('skill toggled', { name, enabled });
  return true;
}

export interface SkillBrowseResult {
  skills: Array<{
    name: string;
    displayName?: string;
    version: string;
    description?: string;
    docs?: string;
    tools: string[];
    installed: boolean;
    installedVersion?: string;
    updateAvailable: boolean;
  }>;
  registryUrl: string;
}

// Browse the curated registry for kind:"skill" entries only — modules ride the
// marketplace route, skills ride this one, off the same index.
export async function browseSkillRegistry(
  deps: PanelDeps,
  opts: SkillRoutesOptions = {},
): Promise<SkillBrowseResult> {
  const url = opts.registryUrl ?? registryUrl();
  const entries = await fetchRegistryIndex({
    url,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  const installed = new Map(listInstalledSkills(deps).map((s) => [s.name, s.version]));
  return {
    registryUrl: url,
    skills: entries
      .filter((e) => e.kind === 'skill')
      .map((e) => {
        const have = installed.get(e.name);
        return {
          name: e.name,
          ...(e.displayName ? { displayName: e.displayName } : {}),
          version: e.version,
          ...(e.description ? { description: e.description } : {}),
          ...(e.docs ? { docs: e.docs } : {}),
          tools: describeTiers(deps, (e.skillTools ?? []) as string[]),
          installed: have !== undefined,
          ...(have !== undefined ? { installedVersion: have } : {}),
          updateAvailable: have !== undefined && isNewer(e.version, have),
        };
      }),
  };
}

export interface SkillInstallResult {
  status: number;
  body: Record<string, unknown>;
}

// Install (or update) a skill from the registry. Fail-closed: an unknown name,
// a non-skill entry, a download/verify/code-free-gate failure, or unconsented
// new tools all stop before touching the live skills root.
export async function installSkillFromRegistry(
  deps: PanelDeps,
  args: { name: string; acceptAdded?: boolean },
  opts: SkillRoutesOptions = {},
): Promise<SkillInstallResult> {
  const loader = deps.skills?.loader;
  if (!loader) return { status: 503, body: { error: 'skills are not available' } };
  const name = args.name.trim();
  if (!name) return { status: 400, body: { error: 'skill name is required' } };

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
  if (!entry || entry.kind !== 'skill') {
    return { status: 404, body: { error: `no skill '${name}' in the registry` } };
  }

  const dest = userSkillsRoot(deps.home);
  const installedDir = join(dest, name);
  const have = existsSync(installedDir);
  const wantTools = (entry.skillTools ?? []) as string[];
  const priorConsent = have ? readSkillConsent(installedDir) : [];
  const added = skillToolDiff(priorConsent, wantTools);

  // Mandatory consent for any tool the user hasn't already granted this skill
  // (every tool on a first install).
  if (added.length > 0 && !args.acceptAdded) {
    return {
      status: 409,
      body: {
        needsConsent: true,
        name,
        version: entry.version,
        update: have,
        added: describeTiers(deps, added),
        tools: describeTiers(deps, wantTools),
      },
    };
  }

  ensurePrivateDir(dest);
  let staged;
  try {
    staged = await stageSkill(entry, {
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
    committed = commitSkill(staged, dest, { replace: have });
  } catch (e) {
    discardSkill(staged);
    return { status: 400, body: { error: e instanceof InstallError ? e.message : String(e) } };
  }
  writeSkillConsent(committed, wantTools);

  try {
    await loader.reload(name);
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
  deps.log.info('skill installed from registry', { name, version: entry.version, update: have });
  return { status: 200, body: { ok: true, name, version: entry.version, update: have } };
}

// Uninstall a user-installed skill. First-party skills shipped in the repo's
// skills/ dir are not removable here (they aren't under the user skills root);
// the route reports that rather than touching the repo tree.
export async function uninstallSkill(deps: PanelDeps, name: string): Promise<SkillInstallResult> {
  const loader = deps.skills?.loader;
  if (!loader) return { status: 503, body: { error: 'skills are not available' } };
  const dir = join(userSkillsRoot(deps.home), name);
  if (!existsSync(dir)) {
    return { status: 404, body: { error: `'${name}' is not a user-installed skill` } };
  }
  rmSync(dir, { recursive: true, force: true });
  deps.db.prepare(`DELETE FROM skill_state WHERE name = ?`).run(name);
  await loader.unload(name);
  deps.log.info('skill uninstalled', { name });
  return { status: 200, body: { ok: true, name } };
}

export function createSkillRoutes(deps: PanelDeps, opts: SkillRoutesOptions = {}): RouteModule {
  return async ({ req, res, path, method }) => {
    if (path === '/api/skills' && method === 'GET') {
      sendJson(res, 200, { skills: listInstalledSkills(deps) });
      return true;
    }

    if (path === '/api/skills/registry' && method === 'GET') {
      try {
        sendJson(res, 200, await browseSkillRegistry(deps, opts));
      } catch (e) {
        sendJson(res, 502, { error: e instanceof InstallError ? e.message : String(e) });
      }
      return true;
    }

    if (path === '/api/skills/registry/install' && method === 'POST') {
      const { name, acceptAdded } = await readJson<{ name?: string; acceptAdded?: boolean }>(req);
      const r = await installSkillFromRegistry(deps, { name: name ?? '', acceptAdded: !!acceptAdded }, opts);
      sendJson(res, r.status, r.body);
      return true;
    }

    const action = /^\/api\/skills\/([a-z0-9._-]+)\/(enable|disable|uninstall)$/i.exec(path);
    if (action && method === 'POST') {
      const name = action[1]!;
      const verb = action[2]!.toLowerCase();
      if (verb === 'uninstall') {
        const r = await uninstallSkill(deps, name);
        sendJson(res, r.status, r.body);
        return true;
      }
      const ok = await setSkillEnabled(deps, name, verb === 'enable');
      sendJson(res, ok ? 200 : 404, ok ? { ok: true, name, enabled: verb === 'enable' } : { error: `unknown skill '${name}'` });
      return true;
    }

    return false;
  };
}
