// Declarative-skill loader — the deliberately tiny sibling of the module loader
// (modules.ts). It discovers skill.json bundles, validates them, and registers
// a SkillRecord. What it does NOT have is the security guarantee: there is no
// Host object and no dynamic import anywhere on this path, so the loader
// provably cannot run code from a skill bundle. A skill is pure prompt data — a
// summary, a playbook, and a reference to tools the user already consented to.
//
// assertNoExecutableContent runs again here (after the installer's stage-time
// gate) so even a skill folder dropped straight into ~/.modulus/skills, hand-
// placed past the installer, is held to the same code-free contract. That is
// the "enforced at install-time AND load-time" pillar of the threat model.
//
// What it shares with the module loader, by deliberate reuse:
//   * the hot-reload watcher (createModuleWatcher), pointed at skill.json
//   * the syncManifestAgents upsert pattern, with origin 'skill:<name>'
//   * an enabled/disabled lifecycle row (skill_state mirrors module_state)
// What it omits on purpose: entrypoints, settings, per-skill migrations, and
// the entire Host surface. A skill cannot register a tool; it can only point at
// tools that already exist and that consent already granted.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '../storage/db.js';
import type { Logger } from '../util/log.js';
import type { ToolRegistry } from './tools.js';
import {
  assertNoExecutableContent,
  MAX_INTENT_PATTERN_LEN,
  MAX_SKILL_INSTRUCTIONS_BYTES,
} from './installer.js';
import { satisfiesModulusRange, type AgentFleetRegistrar, type ManifestAgent } from './modules.js';
import { createModuleWatcher } from './module-watcher.js';

// Matches the registry's MODULE_NAME_RE — a skill name is validated identically
// to a module name. Re-checked here as defense in depth against a hand-placed
// folder that never passed through the installer.
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const AGENT_NAME_RE = /^[a-z0-9][a-z0-9_-]{1,40}$/i;

export interface SkillManifest {
  kind: 'skill';
  name: string;
  version: string;
  description?: string;
  // Semver range understood by the host, e.g. ">=1.5.0" or "*".
  modulus: string;
  // One-liner the model sees in the availability block (Phase C). Required.
  summary: string;
  // Playbook filename within the bundle. Defaults to SKILL.md.
  instructions?: string;
  // Allowlist of EXISTING tool names. The skill grants no tools; activation
  // intersects this with installed+permitted tools (Phase C).
  tools?: string[];
  // Optional availability signal (a case-insensitive regex), length-capped.
  intent_pattern?: string;
  // Declarative personas, synced into the fleet with origin 'skill:<name>'.
  agents?: ManifestAgent[];
}

export interface SkillRecord {
  name: string;
  version: string;
  enabled: boolean;
  summary: string;
  // Full SKILL.md text, byte-capped at load. Fed back to the model (fenced) by
  // the use_skill tool in Phase C — it never sits in the standing prompt.
  instructions: string;
  // Declared tool allowlist; intersected with installed+permitted tools at
  // activation. Never widens a grant beyond consent.
  toolAllowlist: string[];
  // Compiled availability signal; undefined when absent, over the length cap,
  // or not a valid regex.
  intentPattern?: RegExp;
  registeredAgents: string[];
  loadedAt: number;
  // Set when validation/the code-free gate failed; the skill is present but not
  // usable. Kept (rather than dropped) so the panel can show why.
  error?: string;
}

export interface SkillLoaderOptions {
  // Search paths for skill folders. Each is scanned non-recursively; each
  // subdirectory with a skill.json is one skill. Typically ~/.modulus/skills
  // plus, once first-party skills ship, the repo's skills/ dir.
  roots: string[];
  db: DB;
  log: Logger;
  // Host version — validates each skill.json's `modulus` range.
  hostVersion: string;
  // Used only to flag (warn) tool names a skill references that aren't
  // registered. The activation-time intersection is the real enforcement.
  tools: ToolRegistry;
  // When provided, skill `agents` sync into the fleet (origin 'skill:<name>').
  agents?: AgentFleetRegistrar;
  // Disable hot-reload (tests).
  watch?: boolean;
  onDidReload?: () => void | Promise<void>;
}

export interface SkillLoader {
  loadAll(): Promise<void>;
  reload(name: string): Promise<void>;
  unload(name: string): Promise<void>;
  list(): SkillRecord[];
  get(name: string): SkillRecord | undefined;
  reloadCounts(): Record<string, number>;
  shutdown(): Promise<void>;
}

export function createSkillLoader(opts: SkillLoaderOptions): SkillLoader {
  const log = opts.log.child({ mod: 'skills' });
  const loaded = new Map<string, SkillRecord>();
  const dirs = new Map<string, string>(); // skill name -> resolved folder
  let shuttingDown = false;

  const watcher = createModuleWatcher({
    log,
    roots: opts.roots,
    manifestFile: 'skill.json',
    isShuttingDown: () => shuttingDown,
    loadModule: (folder) => loadOne(folder),
    unloadModule: (name) => unloadInternal(name),
    ...(opts.onDidReload ? { onDidReload: opts.onDidReload } : {}),
    isFolderLoaded: (folder) => [...dirs.values()].some((f) => f === folder),
    nameForFolder: (folder) => [...dirs.entries()].find(([, f]) => f === folder)?.[0],
  });

  // -- skill-provided agents (origin 'skill:<name>') ------------------------
  // Identical upsert semantics to the module loader's syncManifestAgents: keyed
  // by name, guarded by origin so a skill can never hijack a user's (or a
  // module's) agent, durable across reloads (task history hangs off the id),
  // and swept when the skill stops declaring it. The one difference: a skill
  // owns no tools, so a persona's default scope is the skill's consented tool
  // allowlist, not "this skill's own tools".
  function syncSkillAgents(manifest: SkillManifest, cl: Logger): string[] {
    const registrar = opts.agents;
    if (!registrar) return [];
    const origin = `skill:${manifest.name}`;
    const skillTools = Array.isArray(manifest.tools) ? manifest.tools : [];
    const wanted = new Set<string>();
    const registered: string[] = [];
    for (const spec of manifest.agents ?? []) {
      const name = String(spec?.name ?? '').trim();
      const systemPrompt = String(spec?.systemPrompt ?? '').trim();
      if (!AGENT_NAME_RE.test(name) || !systemPrompt) {
        cl.warn('skill agent skipped (bad name or empty systemPrompt)', { agent: name });
        continue;
      }
      const profile =
        (['chat', 'tools', 'reason'] as const).find((p) => p === spec.profile) ?? 'tools';
      const mode = spec.mode === 'autonomous' ? ('autonomous' as const) : ('single' as const);
      const fields = {
        role: spec.role ?? `Specialist provided by the ${manifest.name} skill`,
        systemPrompt,
        toolAllowlist: spec.toolAllowlist === undefined ? skillTools : spec.toolAllowlist,
        profile,
        mode,
        ...(typeof spec.maxToolRounds === 'number' ? { maxToolRounds: spec.maxToolRounds } : {}),
      };
      const existing = registrar.getByName(name);
      if (existing && existing.origin !== origin) {
        cl.warn('skill agent collides with an existing agent — skipped', { agent: name });
        continue;
      }
      try {
        if (existing) registrar.update(existing.id, fields);
        else registrar.create({ name, ...fields, origin });
        wanted.add(name);
        registered.push(name);
      } catch (e) {
        cl.warn('skill agent registration failed', {
          agent: name,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    for (const a of registrar.list()) {
      if (a.origin === origin && !wanted.has(a.name)) registrar.remove(a.id);
    }
    return registered;
  }

  function removeSkillAgents(skillName: string): void {
    const registrar = opts.agents;
    if (!registrar) return;
    const origin = `skill:${skillName}`;
    for (const a of registrar.list()) {
      if (a.origin === origin) registrar.remove(a.id);
    }
  }

  function ensureStateRow(manifest: SkillManifest): boolean {
    const existing = opts.db
      .prepare(`SELECT enabled, version FROM skill_state WHERE name = ?`)
      .get(manifest.name) as { enabled: number; version: string } | undefined;
    if (!existing) {
      opts.db
        .prepare(
          `INSERT INTO skill_state (name, version, enabled, installed_at, last_loaded_at)
           VALUES (?, ?, 1, ?, ?)`,
        )
        .run(manifest.name, manifest.version, Date.now(), Date.now());
      return true;
    }
    if (existing.version !== manifest.version) {
      opts.db
        .prepare(`UPDATE skill_state SET version = ?, last_loaded_at = ? WHERE name = ?`)
        .run(manifest.version, Date.now(), manifest.name);
    } else {
      opts.db
        .prepare(`UPDATE skill_state SET last_loaded_at = ? WHERE name = ?`)
        .run(Date.now(), manifest.name);
    }
    return existing.enabled !== 0;
  }

  // Record a present-but-unusable skill so the panel can explain the failure,
  // and drop any personas it had (their tools may be gone).
  function recordError(name: string, version: string, error: string): void {
    removeSkillAgents(name);
    loaded.set(name, {
      name,
      version,
      enabled: true,
      summary: '',
      instructions: '',
      toolAllowlist: [],
      registeredAgents: [],
      loadedAt: Date.now(),
      error,
    });
  }

  function validateManifest(raw: unknown): SkillManifest | null {
    if (!raw || typeof raw !== 'object') return null;
    const m = raw as Record<string, unknown>;
    if (m['kind'] !== 'skill') return null;
    if (typeof m['name'] !== 'string' || !SKILL_NAME_RE.test(m['name'])) return null;
    if (typeof m['version'] !== 'string') return null;
    if (typeof m['modulus'] !== 'string') return null;
    if (typeof m['summary'] !== 'string' || m['summary'].trim() === '') return null;
    return m as unknown as SkillManifest;
  }

  async function loadOne(folder: string): Promise<void> {
    const skillJson = join(folder, 'skill.json');
    if (!existsSync(skillJson)) return;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(skillJson, 'utf8'));
    } catch (e) {
      log.warn('skill.json is not valid JSON — skipping', {
        path: skillJson,
        error: e instanceof Error ? e.message : 'parse error',
      });
      return;
    }
    const manifest = validateManifest(raw);
    if (!manifest) {
      log.warn('skill.json failed validation — skipping', { path: skillJson });
      return;
    }

    // Re-enter loadOne cleanly on reload.
    if (loaded.has(manifest.name)) await unloadInternal(manifest.name);
    dirs.set(manifest.name, folder);
    if (opts.watch !== false && !shuttingDown) watcher.watchModuleFolder(manifest.name, folder);

    const cl = log.child({ skill: manifest.name });

    if (!satisfiesModulusRange(opts.hostVersion, manifest.modulus)) {
      recordError(
        manifest.name,
        manifest.version,
        `needs Modulus ${manifest.modulus}, host is ${opts.hostVersion}`,
      );
      cl.warn('skill requires a newer Modulus — skipped', { range: manifest.modulus });
      return;
    }

    // The code-free gate, re-run at LOAD time. A skill folder that slipped past
    // the installer (hand-placed) is held to the same contract: no executable
    // file, no node_modules/, no migrations/. The loader never imports anyway,
    // so this is defense in depth — but it makes the guarantee enforced on both
    // the install and load paths, with a test for each.
    try {
      assertNoExecutableContent(folder);
    } catch (e) {
      recordError(manifest.name, manifest.version, e instanceof Error ? e.message : String(e));
      cl.error('skill carries executable content — refusing to load', {
        error: e instanceof Error ? e.message : String(e),
      });
      return;
    }

    const enabled = ensureStateRow(manifest);
    if (!enabled) {
      cl.info('skill is disabled — skipping load');
      removeSkillAgents(manifest.name);
      loaded.set(manifest.name, {
        name: manifest.name,
        version: manifest.version,
        enabled: false,
        summary: manifest.summary,
        instructions: '',
        toolAllowlist: [],
        registeredAgents: [],
        loadedAt: Date.now(),
      });
      return;
    }

    // Playbook. Cap the bytes that can reach the prompt even for a hand-placed
    // skill the installer never sized; truncate rather than drop so the skill
    // stays usable.
    const instrFile = typeof manifest.instructions === 'string' ? manifest.instructions : 'SKILL.md';
    const instrPath = join(folder, instrFile);
    if (!existsSync(instrPath)) {
      recordError(manifest.name, manifest.version, `missing playbook (${instrFile})`);
      cl.warn('skill is missing its playbook — skipped', { instructions: instrFile });
      return;
    }
    let instructions = readFileSync(instrPath, 'utf8');
    if (Buffer.byteLength(instructions, 'utf8') > MAX_SKILL_INSTRUCTIONS_BYTES) {
      instructions = instructions.slice(0, MAX_SKILL_INSTRUCTIONS_BYTES);
      cl.warn('skill playbook exceeds the cap — truncated', { cap: MAX_SKILL_INSTRUCTIONS_BYTES });
    }

    const toolAllowlist = Array.isArray(manifest.tools)
      ? manifest.tools.filter((t): t is string => typeof t === 'string')
      : [];
    for (const t of toolAllowlist) {
      if (!opts.tools.get(t)) {
        // Not fatal: a referenced tool may belong to a module that isn't
        // installed/enabled. The activation intersection just won't grant it.
        cl.info('skill references a tool that is not currently installed', { tool: t });
      }
    }

    let intentPattern: RegExp | undefined;
    if (typeof manifest.intent_pattern === 'string') {
      if (manifest.intent_pattern.length > MAX_INTENT_PATTERN_LEN) {
        cl.warn('skill intent_pattern exceeds the length cap; ignoring', {
          length: manifest.intent_pattern.length,
        });
      } else {
        try {
          intentPattern = new RegExp(manifest.intent_pattern, 'i');
        } catch (e) {
          cl.warn('skill intent_pattern is not a valid regex; ignoring', {
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }

    const registeredAgents = syncSkillAgents(manifest, cl);

    const record: SkillRecord = {
      name: manifest.name,
      version: manifest.version,
      enabled: true,
      summary: manifest.summary,
      instructions,
      toolAllowlist,
      registeredAgents,
      loadedAt: Date.now(),
      ...(intentPattern ? { intentPattern } : {}),
    };
    loaded.set(manifest.name, record);
    cl.info('skill loaded', {
      version: manifest.version,
      tools: toolAllowlist.length,
      agents: registeredAgents.length,
    });
  }

  async function unloadInternal(name: string): Promise<void> {
    // A reload's unload still has the folder on disk and must keep the skill's
    // fleet agents (task history hangs off their ids); a removed folder is an
    // uninstall, so the agents go.
    const folder = dirs.get(name);
    if (!folder || !existsSync(folder)) removeSkillAgents(name);
    dirs.delete(name);
    loaded.delete(name);
    watcher.detach(name);
  }

  async function loadAll(): Promise<void> {
    for (const root of opts.roots) {
      let entries: string[];
      try {
        entries = readdirSync(root);
      } catch {
        // A missing root (e.g. no first-party skills dir yet) is fine.
        continue;
      }
      for (const entry of entries) {
        const folder = join(root, entry);
        try {
          if (!statSync(folder).isDirectory()) continue;
          await loadOne(folder);
        } catch (e) {
          log.warn('skill discovery failed', {
            folder,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }
    // Orphan sweep: a skill uninstalled while the daemon was down never got its
    // unload, so its 'skill:<name>' personas would linger pointing at nothing.
    if (opts.agents) {
      const present = new Set(
        [...loaded.values()].filter((e) => e.enabled && !e.error).map((e) => `skill:${e.name}`),
      );
      for (const a of opts.agents.list()) {
        if (a.origin && a.origin.startsWith('skill:') && !present.has(a.origin)) {
          log.info('removing orphaned skill agent', { agent: a.name, origin: a.origin });
          opts.agents.remove(a.id);
        }
      }
    }
    if (opts.watch !== false) watcher.startRootWatchers();
  }

  async function reload(name: string): Promise<void> {
    const folder = dirs.get(name);
    if (!folder) {
      for (const root of opts.roots) {
        const candidate = join(root, name);
        if (existsSync(join(candidate, 'skill.json'))) {
          await loadOne(candidate);
          await opts.onDidReload?.();
          return;
        }
      }
      throw new Error(`skill '${name}' not found`);
    }
    await loadOne(folder);
    await opts.onDidReload?.();
  }

  async function shutdown(): Promise<void> {
    shuttingDown = true;
    await watcher.stop();
    for (const name of [...loaded.keys()]) await unloadInternal(name);
  }

  return {
    loadAll,
    reload,
    unload: (name: string) => unloadInternal(name),
    list: () => [...loaded.values()],
    get: (name: string) => loaded.get(name),
    reloadCounts: () => watcher.reloadCounts(),
    shutdown,
  };
}
