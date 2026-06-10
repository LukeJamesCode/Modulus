// Modules (extensions) routes: list installed modules with manifest + readiness
// + settings schema, edit settings, and enable/disable/install/uninstall via the
// CLI (the same path `modulus ext` uses, so native-dep setup runs too). The
// daemon stays the install owner; the panel just drives it.
//
// Deferred to later passes: the interactive OAuth auth flows and binary
// upload. /api/commands lives here because it reuses listExtensions.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configureNativeDepsForExtension } from '../../cli/ext-setup.js';
import { collectExtensionReadiness } from '../../core/extension-readiness.js';
import type { Manifest, SettingsSchema } from '../../core/extensions.js';
import { readJson, sendJson, sse, writeSseHead } from '../http.js';
import type { RouteModule } from '../router.js';
import type { PanelDeps } from '../types.js';
import type { DB } from '../../storage/db.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

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

function readExtSettings(db: DB, ext: string): Map<string, string> {
  const rows = db
    .prepare(`SELECT key, value FROM extension_settings WHERE extension = ?`)
    .all(ext) as Array<{ key: string; value: string }>;
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
      label: humanize(key),
      type,
      value,
      ...(decl.format ? { format: decl.format } : {}),
      ...(decl.description ? { help: decl.description } : {}),
      required: required.has(key),
    };
  });
}

function findExtFolder(roots: readonly string[], name: string): string | null {
  for (const root of roots) {
    const candidate = join(root, name);
    if (existsSync(join(candidate, 'manifest.json'))) return candidate;
  }
  return null;
}

function listExtensions(deps: PanelDeps): unknown[] {
  const readiness = collectExtensionReadiness(deps.extensionRoots, deps.db);
  return readiness
    .map((r) => {
      const manifest = readManifest(r.folder);
      const schema = readSchema(r.folder);
      const current = readExtSettings(deps.db, r.name);
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
  { cmd: '/extensions', desc: 'List installed modules and their state' },
  { cmd: '/devmode', desc: 'Append per-reply diagnostics to each response' },
  { cmd: '/setup', desc: 'Owner-only setup wizard inside Telegram' },
  { cmd: '/fresh', desc: 'Owner-only destructive fresh rebuild from Telegram' },
];

// The CLI entrypoint to re-exec for `modulus ext …` actions. Prefers the one we
// were launched with; falls back to the built or source entry.
function cliEntryPath(deps: PanelDeps): string {
  if (deps.cliEntry && existsSync(deps.cliEntry)) return deps.cliEntry;
  const built = join(REPO_ROOT, 'dist', 'cli', 'index.js');
  if (existsSync(built)) return built;
  return join(REPO_ROOT, 'src', 'cli', 'index.ts');
}

function runModulus(
  deps: PanelDeps,
  args: string[],
  timeoutMs = 120_000,
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [...(deps.execArgv ?? []), cliEntryPath(deps), ...args], {
      cwd: REPO_ROOT,
      env: process.env,
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    timer.unref();
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveRun({ code: code ?? -1, out, err });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolveRun({ code: -1, out, err: err + String(e) });
    });
  });
}

// Like runModulus, but hands output chunks to the caller as they arrive — the
// enable-stream SSE relays them so a big model download shows progress lines
// instead of a frozen spinner. Generous timeout for exactly that case.
function runModulusStreaming(
  deps: PanelDeps,
  args: string[],
  onChunk: (text: string) => void,
  timeoutMs = 1_800_000,
): Promise<{ code: number }> {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [...(deps.execArgv ?? []), cliEntryPath(deps), ...args], {
      cwd: REPO_ROOT,
      env: process.env,
    });
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    timer.unref();
    child.stdout.on('data', (d: Buffer) => onChunk(d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => onChunk(d.toString('utf8')));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveRun({ code: code ?? -1 });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      onChunk(String(e));
      resolveRun({ code: -1 });
    });
  });
}

// Run a module's `setup` entrypoint (native-dep bootstrap) non-interactively,
// the same way `modulus init` does after the user picks modules.
async function runExtSetup(
  deps: PanelDeps,
  name: string,
  onChunk?: (text: string) => void,
): Promise<{ ok: boolean; output: string }> {
  const folder = findExtFolder(deps.extensionRoots, name);
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
    await configureNativeDepsForExtension({ name, folder, manifest }, deps.db, deps.home, {
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

function saveExtSettings(deps: PanelDeps, name: string, body: Record<string, unknown>): boolean {
  const folder = findExtFolder(deps.extensionRoots, name);
  if (!folder) return false;
  const schema = readSchema(folder);
  if (!schema) return false;
  const now = Date.now();
  const stmt = deps.db.prepare(
    `INSERT INTO extension_settings (extension, key, value, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(extension, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
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

export function createModuleRoutes(deps: PanelDeps): RouteModule {
  return async ({ req, res, url, path, method }) => {
    if (path === '/api/extensions' && method === 'GET') {
      sendJson(res, 200, { extensions: listExtensions(deps) });
      return true;
    }

    if (path === '/api/commands' && method === 'GET') {
      const extension = listExtensions(deps)
        .filter((e): e is { enabled: boolean; commands: Array<{ cmd: string; desc: string }> } => {
          const ext = e as { enabled?: boolean };
          return ext.enabled === true;
        })
        .flatMap((e) => e.commands);
      sendJson(res, 200, { core: CORE_COMMANDS, extensions: extension });
      return true;
    }

    // SSE stream of `ext enable` + native-dep setup output, so a user staring
    // at a 150 MB model download sees lines arriving instead of a frozen
    // "Setting up…" spinner. Unnamed frames with a `type` field — the browser
    // reads this through native EventSource.onmessage.
    const extStream = /^\/api\/extensions\/([a-z0-9._-]+)\/enable-stream$/i.exec(path);
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
        const r = await runModulusStreaming(deps, ['ext', 'enable', name], sendChunk);
        if (r.code !== 0) {
          send({ type: 'done', ok: false, error: `ext enable exited ${r.code}` });
        } else {
          // Best-effort, mirroring the non-stream enable: a failed setup
          // doesn't undo the enable.
          const s = await runExtSetup(deps, name, sendChunk);
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

    const extAction =
      /^\/api\/extensions\/([a-z0-9._-]+)\/(enable|disable|install|uninstall|settings|setup)$/i.exec(
        path,
      );
    if (extAction) {
      const name = extAction[1]!;
      const action = extAction[2]!;
      if (action === 'settings' && method === 'GET') {
        const folder = findExtFolder(deps.extensionRoots, name);
        if (!folder) {
          sendJson(res, 404, { error: `module '${name}' not found` });
          return true;
        }
        const current = readExtSettings(deps.db, name);
        sendJson(res, 200, { name, schema: schemaToFields(readSchema(folder), current) });
        return true;
      }
      if (action === 'settings' && method === 'POST') {
        const ok = saveExtSettings(deps, name, await readJson<Record<string, unknown>>(req));
        sendJson(res, ok ? 200 : 400, ok ? { ok: true } : { error: 'no settings schema' });
        return true;
      }
      if (action === 'setup' && method === 'POST') {
        const r = await runExtSetup(deps, name);
        sendJson(res, r.ok ? 200 : 500, r);
        return true;
      }
      if (method === 'POST') {
        const args =
          action === 'uninstall'
            ? ['ext', 'uninstall', name, ...(url.searchParams.get('purge') ? ['--purge'] : [])]
            : ['ext', action, name];
        const r = await runModulus(deps, args);
        // Enabling should also bootstrap native deps (mirrors `modulus init`).
        // Best-effort: a failed setup doesn't undo the enable.
        let setupOutput = '';
        if (r.code === 0 && action === 'enable') {
          try {
            setupOutput = (await runExtSetup(deps, name)).output;
          } catch (e) {
            setupOutput = e instanceof Error ? e.message : String(e);
          }
        }
        sendJson(res, r.code === 0 ? 200 : 500, {
          ok: r.code === 0,
          output: r.out + r.err + setupOutput,
        });
        return true;
      }
    }

    // Deferred: /auth/* (OAuth) and /upload (binary). 404 until then.
    return false;
  };
}
