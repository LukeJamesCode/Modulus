// Modules routes: list installed modules with manifest + readiness
// + settings schema, edit settings, and enable/disable/install/uninstall via the
// CLI (the same path `modulus mod` uses, so native-dep setup runs too). The
// daemon stays the install owner; the panel just drives it.
//
// The interactive auth bridge: `modulus auth <module>` runs a module's OAuth/
// credential flow as print()/prompt() over an AuthFlowIO. Here the same runner
// (runAuthForModule) is wired to the browser instead of a terminal — print lines
// stream out over SSE, prompt() parks the flow until the user POSTs an answer
// back. In-process the flow runs against the daemon's live DB, and a finished
// auth hot-reloads the module so fresh credentials take effect immediately.

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, join } from 'node:path';
import { discover, runAuthForModule, type AuthRunnerIO } from '../../cli/auth.js';
import { ensurePrivateDir } from '../../cli/config-store.js';
import { configureNativeDepsForModule } from '../../cli/ext-setup.js';
import { collectModuleReadiness } from '../../core/module-readiness.js';
import { REAL_TELEGRAM_CHAT_SQL } from '../../core/agents.js';
import type { Manifest, SettingsSchema, TelegramCommandContext } from '../../core/modules.js';
import { readJson, readRawBody, sendJson, sse, writeSseHead } from '../http.js';
import type { RouteModule } from '../router.js';
import { setModuleEnabledState, uninstallModuleFiles } from '../../cli/module-admin.js';
import type { PanelDeps } from '../types.js';
import type { DB } from '../../storage/db.js';
import type { ModulusConfig } from '../../cli/config-store.js';

interface FieldView {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'secret' | 'enum';
  value: string | number | boolean;
  format?: string;
  help?: string;
  options?: string[];
  required?: boolean;
}

function humanize(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function maskToken(token: string): string {
  if (!token) return '';
  if (token.length <= 12) return '••••••';
  return `${token.slice(0, 8)}${'•'.repeat(18)}${token.slice(-4)}`;
}

function readModuleSettings(db: DB, mod: string): Map<string, string> {
  const rows = db
    .prepare(`SELECT key, value FROM module_settings WHERE module = ?`)
    .all(mod) as Array<{ key: string; value: string }>;
  return new Map(rows.map((r) => [r.key, r.value]));
}

function readManifest(folder: string): Manifest | null {
  try {
    return JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')) as Manifest;
  } catch {
    return null;
  }
}

function readSchema(folder: string): SettingsSchema | null {
  const p = join(folder, 'settings.schema.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as SettingsSchema;
  } catch {
    return null;
  }
}

function schemaToFields(schema: SettingsSchema | null, current: Map<string, string>): FieldView[] {
  if (!schema) return [];
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties).map(([key, decl]) => {
    const raw = current.get(key);
    const isSecret = decl.secret === true;
    const stored = raw !== undefined ? raw : decl.default;
    let value: string | number | boolean = stored ?? '';
    let type: FieldView['type'] = decl.type;
    if (isSecret) {
      type = 'secret';
      value = raw ? maskToken(raw) : '';
    } else if (decl.type === 'boolean') {
      value = raw !== undefined ? raw === 'true' : decl.default === true;
    } else if (decl.type === 'number') {
      value = raw !== undefined ? Number(raw) : ((decl.default as number) ?? 0);
    }
    return {
      key,
      label: decl.title ?? humanize(key),
      type,
      value,
      ...(decl.format ? { format: decl.format } : {}),
      ...(decl.description ? { help: decl.description } : {}),
      required: required.has(key),
    };
  });
}

function findModuleFolder(roots: readonly string[], name: string): string | null {
  for (const root of roots) {
    const candidate = join(root, name);
    if (existsSync(join(candidate, 'manifest.json'))) return candidate;
  }
  return null;
}

function listModules(deps: PanelDeps): unknown[] {
  const readiness = collectModuleReadiness(deps.moduleRoots, deps.db);
  return readiness
    .map((r) => {
      const manifest = readManifest(r.folder);
      const schema = readSchema(r.folder);
      const current = readModuleSettings(deps.db, r.name);
      const caps = manifest?.capabilities ?? [];
      const commands = (manifest?.telegram_commands ?? []).map((c) => ({
        cmd: `/${c.command}`,
        desc: c.description,
      }));
      const ep = manifest?.entrypoints ?? {};
      const needsAuth = !!ep.auth || caps.includes('auth:oauth');
      return {
        name: r.name,
        version: r.version,
        description: manifest?.description ?? '',
        source: r.source,
        installed: true,
        enabled: r.enabled,
        self: false,
        removable: r.source === 'user',
        hasSetup: !!ep.setup,
        status: r.status,
        reasons: r.reasons,
        ...(r.nextAction ? { nextAction: r.nextAction } : {}),
        capabilities: caps,
        needsAuth,
        authConnected: needsAuth && r.status !== 'needs_auth',
        deps: manifest?.deps ?? [],
        tools: ep.tools ? [{ name: 'tools', desc: 'Adds AI-callable tools' }] : [],
        commands,
        jobs: ep.jobs ? ['Runs scheduled background jobs'] : [],
        schema: schemaToFields(schema, current),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

const CORE_COMMANDS = [
  { cmd: '/start', desc: 'Welcome message and quick how-to' },
  { cmd: '/help', desc: 'List all installed commands, grouped by module' },
  { cmd: '/newchat', desc: 'Reset conversation context and start fresh' },
  { cmd: '/stop', desc: 'Cancel an in-flight reply' },
  { cmd: '/model', desc: 'Show the active model profiles (chat / reason / tools)' },
  { cmd: '/status', desc: 'Bot uptime, Ollama health, modules, queue depth' },
  { cmd: '/lasterror', desc: 'Show the last orchestrator error for this chat' },
  { cmd: '/modules', desc: 'List installed modules and their state' },
  { cmd: '/devmode', desc: 'Append per-reply diagnostics to each response' },
  { cmd: '/setup', desc: 'Owner-only setup wizard inside Telegram' },
  { cmd: '/fresh', desc: 'Owner-only destructive fresh rebuild from Telegram' },
];

// The core text commands the panel answers itself (no orchestrator turn) — the
// rest fall through to a module command handler.
const CORE_TEXT_COMMANDS = new Set(['help', 'model', 'status', 'modules', 'lasterror']);

interface ModuleListItem {
  name: string;
  enabled: boolean;
  status: string;
  commands: Array<{ cmd: string; desc: string }>;
}

// Core commands plus every enabled module's commands — shared by the GET
// /api/commands reference and the /help text command.
function commandReference(deps: PanelDeps): {
  core: typeof CORE_COMMANDS;
  modules: Array<{ cmd: string; desc: string }>;
} {
  const modules = (listModules(deps) as ModuleListItem[])
    .filter((e) => e.enabled)
    .flatMap((e) => e.commands);
  return { core: CORE_COMMANDS, modules };
}

// The owner chat/user a panel-run command speaks as — the most recently seen
// chat of an allowlisted user, falling back to the first allowlisted id (same
// rule as the dashboard chat route).
function ownerChat(db: DB, cfg: ModulusConfig): { chatId: number; userId: number } | null {
  const fallback = cfg.telegram.allowedIds[0];
  if (fallback === undefined) return null;
  const placeholders = cfg.telegram.allowedIds.map(() => '?').join(', ');
  const row = db
    .prepare(
      `SELECT chat_id AS chatId, user_id AS userId FROM telegram_chats
        WHERE user_id IN (${placeholders}) AND ${REAL_TELEGRAM_CHAT_SQL}
        ORDER BY last_seen_at DESC LIMIT 1`,
    )
    .get(...cfg.telegram.allowedIds) as { chatId: number; userId: number } | undefined;
  return row ?? { chatId: fallback, userId: fallback };
}

// A core text command's reply, computed in-process from the daemon's live
// handles — the panel parity of the Telegram core-command handlers.
async function coreCommandText(deps: PanelDeps, name: string, chatId: number): Promise<string> {
  switch (name) {
    case 'help': {
      const ref = commandReference(deps);
      const lines = ['Core commands:', ...ref.core.map((c) => `${c.cmd} — ${c.desc}`)];
      if (ref.modules.length > 0) {
        lines.push('', 'Module commands:');
        for (const c of ref.modules) lines.push(`${c.cmd}${c.desc ? ' — ' + c.desc : ''}`);
      }
      return lines.join('\n');
    }
    case 'model': {
      const profiles = deps.llm.listProfiles();
      const lines = Object.entries(profiles).map(([n, cfg]) =>
        cfg ? `${n}: ${cfg.model} (ctx ${cfg.contextTokens})` : `${n}: (not configured)`,
      );
      return lines.join('\n') || 'No model profiles configured.';
    }
    case 'status': {
      const health = await deps.llm.health();
      const mods = (listModules(deps) as ModuleListItem[]).filter((e) => e.enabled);
      return [
        `llm: ${health.ok ? 'ok' : 'down'} (${health.models.length} models)`,
        `modules: ${mods.length === 0 ? 'none' : mods.map((e) => e.name).join(', ')}`,
      ].join('\n');
    }
    case 'modules': {
      const mods = listModules(deps) as ModuleListItem[];
      if (mods.length === 0) return 'No modules installed.';
      return [
        'Modules:',
        ...mods.map((e) => `• ${e.name} — ${e.enabled ? e.status : 'disabled'}`),
      ].join('\n');
    }
    case 'lasterror': {
      const e = deps.orchestrator.lastError(chatId);
      return e ? `Last error: ${e}` : 'No recent errors.';
    }
    default:
      return `Unknown command /${name}.`;
  }
}

// Run a core text command or an enabled module command, collecting its replies.
// Module command handlers reply through the same TelegramCommandContext the
// Telegram adapter passes — the panel just captures the text instead of sending it.
async function runCommand(
  deps: PanelDeps,
  owner: { chatId: number; userId: number },
  name: string,
  args: string,
): Promise<{ ok: boolean; replies?: string[]; error?: string }> {
  const lower = name.toLowerCase();
  if (CORE_TEXT_COMMANDS.has(lower)) {
    return { ok: true, replies: [await coreCommandText(deps, lower, owner.chatId)] };
  }
  const rec = deps.loader.commands().find((c) => c.name === lower);
  if (!rec) return { ok: false, error: `/${name} is not a known command` };
  const replies: string[] = [];
  const cctx: TelegramCommandContext = {
    chatId: owner.chatId,
    userId: owner.userId,
    args,
    reply: async (t) => {
      replies.push(t);
    },
  };
  try {
    await rec.handler(cctx);
  } catch (e) {
    deps.log.warn('module command failed', {
      mod: rec.module,
      command: lower,
      error: e instanceof Error ? e.message : String(e),
    });
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  return { ok: true, replies };
}

// Run a module's `setup` entrypoint (native-dep bootstrap) non-interactively,
// the same way `modulus init` does after the user picks modules.
async function runExtSetup(
  deps: PanelDeps,
  name: string,
  onChunk?: (text: string) => void,
): Promise<{ ok: boolean; output: string }> {
  const folder = findModuleFolder(deps.moduleRoots, name);
  if (!folder) return { ok: false, output: `module '${name}' not found` };
  let manifest: Manifest;
  try {
    manifest = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')) as Manifest;
  } catch (e) {
    return { ok: false, output: e instanceof Error ? e.message : String(e) };
  }
  if (!manifest.entrypoints?.setup) return { ok: true, output: '' };
  let captured = '';
  try {
    await configureNativeDepsForModule({ name, folder, manifest }, deps.db, deps.home, {
      interactive: false,
      stdout: (text) => {
        captured += text;
        onChunk?.(text);
      },
    });
    return { ok: true, output: captured };
  } catch (e) {
    return { ok: false, output: captured + (e instanceof Error ? e.message : String(e)) };
  }
}

function saveModuleSettings(deps: PanelDeps, name: string, body: Record<string, unknown>): boolean {
  const folder = findModuleFolder(deps.moduleRoots, name);
  if (!folder) return false;
  const schema = readSchema(folder);
  if (!schema) return false;
  const now = Date.now();
  const stmt = deps.db.prepare(
    `INSERT INTO module_settings (module, key, value, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(module, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  for (const [key, decl] of Object.entries(schema.properties)) {
    if (!(key in body)) continue;
    const raw = body[key];
    // Never overwrite a stored secret with its masked placeholder or a blank.
    if (decl.secret && typeof raw === 'string' && (raw.includes('•') || raw.trim() === ''))
      continue;
    const value = decl.type === 'boolean' ? (raw ? 'true' : 'false') : String(raw ?? '');
    stmt.run(name, key, value, now);
  }
  return true;
}

interface AuthSseEvent {
  // Monotonic index so a reconnecting EventSource (which gets the whole buffer
  // replayed) can skip events it already processed instead of duplicating them.
  seq?: number;
  type: 'print' | 'prompt' | 'done' | 'error';
  line?: string;
  question?: string;
  secret?: boolean;
  message?: string;
}

interface AuthSession {
  id: string;
  mod: string;
  events: AuthSseEvent[]; // replay buffer for late/reconnecting subscribers
  pending: { resolve: (value: string) => void; reject: (e: Error) => void } | null;
  subscribers: Set<(e: AuthSseEvent) => void>;
  finished: boolean;
}

export function createModuleRoutes(deps: PanelDeps): RouteModule {
  const authSessions = new Map<string, AuthSession>();

  function pushAuthEvent(session: AuthSession, evt: AuthSseEvent): void {
    evt.seq = session.events.length;
    session.events.push(evt);
    for (const sub of session.subscribers) {
      try {
        sub(evt);
      } catch {
        /* a dead subscriber must not break the others */
      }
    }
  }

  function closeAuthSession(session: AuthSession): void {
    if (session.pending) {
      try {
        session.pending.reject(new Error('auth session closed'));
      } catch {
        /* ignore */
      }
      session.pending = null;
    }
    authSessions.delete(session.id);
  }

  function startAuthSession(
    name: string,
  ): { ok: true; session: string } | { ok: false; error: string } {
    const mod = discover(deps.home, name);
    if (!mod) return { ok: false, error: `module '${name}' not found` };
    if (!mod.manifest.entrypoints?.auth) {
      return { ok: false, error: `'${name}' does not have an auth flow` };
    }

    // Only one live auth session per module — replace any stale one.
    for (const s of authSessions.values()) {
      if (s.mod === name && !s.finished) closeAuthSession(s);
    }

    const session: AuthSession = {
      id: randomUUID(),
      mod: name,
      events: [],
      pending: null,
      subscribers: new Set(),
      finished: false,
    };
    authSessions.set(session.id, session);

    const io: AuthRunnerIO = {
      print: (line) => pushAuthEvent(session, { type: 'print', line }),
      announce: (line) => pushAuthEvent(session, { type: 'print', line }),
      prompt: (question, opts) =>
        new Promise<string>((resolve, reject) => {
          session.pending = { resolve, reject };
          pushAuthEvent(session, { type: 'prompt', question, secret: !!opts?.secret });
        }),
    };

    void runAuthForModule(mod, deps.db, io)
      .then(async () => {
        // Fresh credentials must reach the live registrations, not just the DB.
        try {
          await deps.loader.reload(name);
        } catch (e) {
          deps.log.warn('post-auth module reload failed', {
            mod: name,
            error: e instanceof Error ? e.message : String(e),
          });
        }
        pushAuthEvent(session, { type: 'done' });
      })
      .catch((e: unknown) =>
        pushAuthEvent(session, {
          type: 'error',
          message: e instanceof Error ? e.message : String(e),
        }),
      )
      .finally(() => {
        session.finished = true;
        session.pending = null;
        // Keep the finished session around briefly so the SSE delivers the
        // final event to whoever is watching, then drop it.
        setTimeout(() => authSessions.delete(session.id), 60_000).unref();
      });

    return { ok: true, session: session.id };
  }

  function answerAuthSession(id: string, value: string): boolean {
    const session = authSessions.get(id);
    if (!session || !session.pending) return false;
    const { resolve: resolveAnswer } = session.pending;
    session.pending = null;
    resolveAnswer(value);
    return true;
  }

  function streamAuthSession(req: IncomingMessage, res: ServerResponse, id: string): void {
    const session = authSessions.get(id);
    writeSseHead(res);
    if (!session) {
      sse(res, null, { type: 'error', message: 'auth session expired' });
      res.end();
      return;
    }
    const send = (evt: AuthSseEvent): void => sse(res, null, evt);
    // Replay everything so far (a prompt or the final result may predate this
    // connection), then subscribe to live events.
    for (const evt of session.events) send(evt);
    session.subscribers.add(send);
    const keepAlive = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        /* client gone */
      }
    }, 20_000);
    keepAlive.unref?.();
    req.on('close', () => {
      clearInterval(keepAlive);
      session.subscribers.delete(send);
    });
  }

  return async ({ req, res, url, path, method }) => {
    if (path === '/api/modules' && method === 'GET') {
      sendJson(res, 200, { modules: listModules(deps) });
      return true;
    }

    if (path === '/api/commands' && method === 'GET') {
      sendJson(res, 200, commandReference(deps));
      return true;
    }

    // Run a core text command or a module command (the codex buttons, etc.) and
    // return its captured replies — the panel parity of typing the slash command
    // in Telegram.
    if (path === '/api/command' && method === 'POST') {
      const { name, args } = await readJson<{ name?: string; args?: string }>(req);
      // The web UI strips the leading slash, but tolerate it for direct callers.
      const command = (name ?? '').trim().replace(/^\/+/, '');
      if (!command) {
        sendJson(res, 400, { ok: false, error: 'missing command' });
        return true;
      }
      const owner = ownerChat(deps.db, deps.config);
      if (!owner) {
        sendJson(res, 500, { ok: false, error: 'no owner chat configured' });
        return true;
      }
      const r = await runCommand(deps, owner, command, (args ?? '').trim());
      sendJson(res, r.ok ? 200 : r.error?.includes('not a known') ? 404 : 500, r);
      return true;
    }

    // SSE stream of `mod enable` + native-dep setup output, so a user staring
    // at a 150 MB model download sees lines arriving instead of a frozen
    // "Setting up…" spinner. Unnamed frames with a `type` field — the browser
    // reads this through native EventSource.onmessage.
    const extStream = /^\/api\/modules\/([a-z0-9._-]+)\/enable-stream$/i.exec(path);
    if (extStream && method === 'GET') {
      const name = extStream[1]!;
      writeSseHead(res);
      const send = (data: unknown): void => sse(res, null, data);
      const sendChunk = (text: string): void => {
        for (const line of String(text).split(/\r?\n/)) {
          if (line.length > 0) send({ type: 'line', line });
        }
      };
      // Comment frames keep proxies from idling the connection out mid-download.
      const keepAlive = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          /* client gone */
        }
      }, 20_000);
      keepAlive.unref?.();
      req.on('close', () => clearInterval(keepAlive));
      try {
        // Flip enabled in-process (no CLI child boot), then pause hot-reload
        // while setup's npm install churns the folder and load the module
        // exactly once with its deps in place. Best-effort: a failed setup
        // doesn't undo the enable.
        const flip = setModuleEnabledState(deps.db, deps.home, name, true);
        if (!flip.ok) {
          send({ type: 'done', ok: false, error: flip.error });
        } else {
          deps.loader.suspendReload(name);
          let s: { ok: boolean; output: string };
          try {
            s = await runExtSetup(deps, name, sendChunk);
          } finally {
            deps.loader.resumeReload(name);
          }
          try {
            await deps.loader.reload(name);
          } catch (e) {
            deps.log.warn('post-enable module reload failed', {
              mod: name,
              error: e instanceof Error ? e.message : String(e),
            });
          }
          send({ type: 'done', ok: s.ok });
        }
      } catch (e) {
        send({ type: 'done', ok: false, error: e instanceof Error ? e.message : String(e) });
      } finally {
        clearInterval(keepAlive);
        res.end();
      }
      return true;
    }

    // Stage a binary upload (e.g. a recorded voice note) under the module's
    // private uploads dir, returning the saved path for a follow-up tool call.
    // The filename is reduced to a basename so an x-filename header can't escape
    // the uploads dir via path traversal.
    const extUpload = /^\/api\/modules\/([a-z0-9._-]+)\/upload$/i.exec(path);
    if (extUpload && method === 'POST') {
      const name = extUpload[1]!;
      const bytes = await readRawBody(req);
      const header = req.headers['x-filename'];
      const safe = basename(typeof header === 'string' ? header : '').replace(/^\.+/, '');
      const filename = safe || `upload_${Date.now()}.bin`;
      const uploadDir = join(deps.home, 'modules', name, 'uploads');
      ensurePrivateDir(uploadDir);
      const filePath = join(uploadDir, filename);
      writeFileSync(filePath, bytes);
      sendJson(res, 200, { path: filePath });
      return true;
    }

    const extAction =
      /^\/api\/modules\/([a-z0-9._-]+)\/(enable|disable|install|uninstall|settings|setup)$/i.exec(
        path,
      );
    if (extAction) {
      const name = extAction[1]!;
      const action = extAction[2]!;
      if (action === 'settings' && method === 'GET') {
        const folder = findModuleFolder(deps.moduleRoots, name);
        if (!folder) {
          sendJson(res, 404, { error: `module '${name}' not found` });
          return true;
        }
        const current = readModuleSettings(deps.db, name);
        sendJson(res, 200, { name, schema: schemaToFields(readSchema(folder), current) });
        return true;
      }
      if (action === 'settings' && method === 'POST') {
        const ok = saveModuleSettings(deps, name, await readJson<Record<string, unknown>>(req));
        // Modules read settings at register() time — most visibly the assistant's
        // morning/night briefing crons, which are scheduled once from night_time/
        // morning_time. Writing to the DB isn't enough: reload so the live
        // registrations (scheduler jobs, prompts) pick up the new values, matching
        // the auth/enable flows above. Without this a changed briefing time never
        // takes effect until the next daemon restart.
        if (ok) {
          try {
            await deps.loader.reload(name);
          } catch (e) {
            deps.log.warn('post-settings module reload failed', {
              mod: name,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }
        sendJson(res, ok ? 200 : 400, ok ? { ok: true } : { error: 'no settings schema' });
        return true;
      }
      if (action === 'setup' && method === 'POST') {
        const r = await runExtSetup(deps, name);
        sendJson(res, r.ok ? 200 : 500, r);
        return true;
      }
      if (method === 'POST') {
        // enable / disable / uninstall all run in-process now: the DB flip and
        // folder removal go through the shared module-admin helpers (same code
        // path as the CLI), and the live loader is driven directly — no child
        // `modulus` boot on the hot path, and the running daemon's view updates
        // immediately instead of waiting for a watcher tick. `update` keeps its
        // CLI re-exec (git pull + npm install + rebuild) elsewhere.
        if (action === 'uninstall') {
          const result = uninstallModuleFiles(deps.home, name, {
            purge: !!url.searchParams.get('purge'),
            db: deps.db,
          });
          if (result.ok) await deps.loader.unload(name);
          sendJson(res, result.ok ? 200 : 500, {
            ok: result.ok,
            output: result.ok ? `Uninstalled '${name}'.` : (result.error ?? ''),
          });
          return true;
        }

        const enabled = action === 'enable';
        const flip = setModuleEnabledState(deps.db, deps.home, name, enabled);
        if (!flip.ok) {
          sendJson(res, 500, { ok: false, output: flip.error ?? '' });
          return true;
        }
        let setupOutput = '';
        if (enabled) {
          // Enabling should also bootstrap native deps (mirrors `modulus init`).
          // Pause hot-reload while setup's npm install churns the folder; a
          // failed setup is best-effort and doesn't undo the enable.
          deps.loader.suspendReload(name);
          try {
            setupOutput = (await runExtSetup(deps, name)).output;
          } catch (e) {
            setupOutput = e instanceof Error ? e.message : String(e);
          } finally {
            deps.loader.resumeReload(name);
          }
          // One explicit reload now that deps are in place — the watcher no
          // longer storms during the install (node_modules is excluded).
          try {
            await deps.loader.reload(name);
          } catch (e) {
            deps.log.warn('post-enable module reload failed', {
              mod: name,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        } else {
          // Disable: drop the module's live registrations now.
          await deps.loader.unload(name);
        }
        sendJson(res, 200, {
          ok: true,
          output: `${enabled ? 'Enabled' : 'Disabled'} '${name}'.${setupOutput ? '\n' + setupOutput : ''}`,
        });
        return true;
      }
    }

    const authAction = /^\/api\/modules\/([a-z0-9._-]+)\/auth\/(start|stream|answer|cancel)$/i.exec(
      path,
    );
    if (authAction) {
      const name = authAction[1]!;
      const action = authAction[2]!;
      if (action === 'start' && method === 'POST') {
        const r = startAuthSession(name);
        sendJson(res, r.ok ? 200 : 404, r);
        return true;
      }
      if (action === 'stream' && method === 'GET') {
        streamAuthSession(req, res, url.searchParams.get('session') ?? '');
        return true;
      }
      if (action === 'answer' && method === 'POST') {
        const { session, value } = await readJson<{ session?: string; value?: string }>(req);
        const ok = answerAuthSession(session ?? '', value ?? '');
        sendJson(res, ok ? 200 : 409, {
          ok,
          ...(ok ? {} : { error: 'no question is waiting for an answer' }),
        });
        return true;
      }
      if (action === 'cancel' && method === 'POST') {
        const { session } = await readJson<{ session?: string }>(req);
        const s = session ? authSessions.get(session) : undefined;
        if (s) closeAuthSession(s);
        sendJson(res, 200, { ok: true });
        return true;
      }
    }

    // Deferred: /upload (binary). 404 until then.
    return false;
  };
}
