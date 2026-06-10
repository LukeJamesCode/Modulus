// `modulus status` — one-shot summary of bot health.
//
// Reads:
//   • the pid file (running yes/no, uptime if we can read /proc/<pid>/stat)
//   • the config (chat/reason model tags, ollama URL, allowlisted IDs)
//   • Ollama /api/tags (reachable + model count)
//   • the SQLite DB (enabled extension count)
//   • installed extensions and their enabled state
// Default output is plain text, two columns. Pass `--json` for a single
// JSON object on stdout — useful for cron, Prometheus textfile collectors,
// or any monitoring shim that just needs one shell call. Both modes read
// the same data so they stay aligned automatically.

import { existsSync, readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { extensionFolders } from './extension-paths.js';
import { open as openDb } from '../storage/db.js';
import { createLogger } from '../util/log.js';
import { readMetrics } from '../core/metrics.js';
import { effectiveConfig, homeDir } from './config-store.js';
import { isAlive, metricsFilePath, panelTokenPath, readPid } from './daemon.js';
import { probeOllama } from './ollama-probe.js';

interface Row {
  label: string;
  value: string;
}

export interface StatusRunOptions {
  json?: boolean;
  // Output sink, defaults to stdout. Injectable so tests can capture the report
  // without monkey-patching the shared stream (which clobbers the test runner).
  write?: (chunk: string) => void;
}

export async function run(options: StatusRunOptions = {}): Promise<void> {
  const write = options.write ?? ((chunk: string) => void process.stdout.write(chunk));
  const home = homeDir();
  const cfg = effectiveConfig(home);

  const pid = readPid(home);
  const running = pid !== null && isAlive(pid);
  const probe = await probeOllama(cfg.ollama.url);
  const installed = listInstalled(home);

  // DB-derived fields. Held in their own variables so JSON mode can include
  // structured values without re-deriving from the formatted strings.
  let enabledExtensions: number | null = null;
  let dbStatus: 'ok' | 'absent' | 'unreadable' = 'absent';
  let dbError: string | null = null;
  const dbPath = join(home, 'modulus.db');
  if (existsSync(dbPath)) {
    try {
      const log = createLogger({ level: 'warn' });
      const db = openDb({ path: dbPath, log });
      try {
        const exts = db
          .prepare(`SELECT COUNT(*) AS n FROM extension_state WHERE enabled = 1`)
          .get() as { n: number } | undefined;
        enabledExtensions = exts?.n ?? 0;
        dbStatus = 'ok';
      } finally {
        db.close();
      }
    } catch (e) {
      dbStatus = 'unreadable';
      dbError = (e as Error).message;
    }
  }

  const metrics = readMetrics(metricsFilePath(home));

  // Panel link: when the panel is enabled and its bearer token has been
  // generated (on first `modulus start`). Read-only — never create the token
  // here. The URL mirrors how the panel server forms it (see src/panel/).
  const panelEnabled = cfg.panel?.enabled !== false;
  const panelUrl = panelEnabled ? readPanelUrl(home, cfg) : null;

  if (options.json) {
    const total = metrics ? metrics.scheduler.cache.hits + metrics.scheduler.cache.misses : 0;
    const hitRate = metrics && total > 0 ? metrics.scheduler.cache.hits / total : null;
    const out = {
      home,
      running,
      pid,
      ollama: {
        url: cfg.ollama.url,
        ok: probe.ok,
        modelCount: probe.models.length,
      },
      models: {
        chat: cfg.models.chat,
        reason: cfg.models.reason ?? null,
        tools: cfg.models.tools ?? null,
      },
      telegram: {
        allowlistSize: cfg.telegram.allowedIds.length,
      },
      extensions: {
        installed: installed.map((e) => e.name),
        enabledCount: enabledExtensions,
      },
      db: {
        status: dbStatus,
        error: dbError,
      },
      panel: {
        enabled: panelEnabled,
        url: panelUrl,
      },
      scheduler: metrics
        ? {
            jobsRegistered: metrics.scheduler.jobsRegistered,
            ticks: metrics.scheduler.ticks,
            nudgesSent: metrics.scheduler.nudgesSent,
            nudgesDropped: metrics.scheduler.nudgesDropped,
            metricsAgeMs: Date.now() - metrics.updatedAt,
          }
        : null,
      fastCache: metrics
        ? {
            hits: metrics.scheduler.cache.hits,
            misses: metrics.scheduler.cache.misses,
            size: metrics.scheduler.cache.size,
            hitRate,
          }
        : null,
      // Kept stable for downstream consumers; bump if we change shape.
      schemaVersion: 2,
    };
    write(JSON.stringify(out, null, 2) + '\n');
    return;
  }

  const rows: Row[] = [];
  rows.push({ label: 'home', value: home });
  rows.push({ label: 'running', value: running ? `yes (pid ${pid})` : 'no' });
  rows.push({
    label: 'ollama',
    value: probe.ok
      ? `ok @ ${cfg.ollama.url} (${probe.models.length} models)`
      : `down @ ${cfg.ollama.url}`,
  });
  rows.push({
    label: 'chat model',
    value: cfg.models.chat,
  });
  rows.push({
    label: 'reason model',
    value: cfg.models.reason ?? '(none)',
  });
  rows.push({
    label: 'tools model',
    value: cfg.models.tools ?? '(none)',
  });
  rows.push({ label: 'allowlist', value: cfg.telegram.allowedIds.join(',') || '(empty)' });
  rows.push({
    label: 'extensions',
    value: installed.length === 0 ? '(none)' : installed.map((e) => e.name).join(', '),
  });

  if (dbStatus === 'ok') {
    rows.push({ label: 'enabled extensions', value: String(enabledExtensions ?? 0) });
  } else if (dbStatus === 'unreadable') {
    rows.push({ label: 'db', value: `unreadable: ${dbError}` });
  } else {
    rows.push({ label: 'db', value: '(not initialized)' });
  }

  if (panelUrl) {
    rows.push({ label: 'panel', value: panelUrl });
  }

  if (metrics) {
    const ageS = Math.round((Date.now() - metrics.updatedAt) / 1000);
    const stale = ageS > 120 ? ` (stale ${ageS}s)` : '';
    const s = metrics.scheduler;
    const dropped = Object.entries(s.nudgesDropped)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k}=${n}`)
      .join(',');
    rows.push({
      label: 'scheduler',
      value:
        `${s.jobsRegistered} jobs, ${s.ticks} ticks, ${s.nudgesSent} nudges sent` +
        (dropped ? ` (dropped: ${dropped})` : '') +
        stale,
    });
    const total = s.cache.hits + s.cache.misses;
    const rate = total === 0 ? 'n/a' : `${Math.round((s.cache.hits / total) * 100)}%`;
    rows.push({
      label: 'fast-cache',
      value: `${rate} hit rate (${s.cache.hits}/${total}, ${s.cache.size} keys)`,
    });
  } else if (running) {
    rows.push({ label: 'scheduler', value: '(metrics file not yet written)' });
  }

  const width = Math.max(...rows.map((r) => r.label.length));
  for (const r of rows) {
    write(`${r.label.padEnd(width)}  ${r.value}\n`);
  }
}

// Reconstruct the tokenized panel link without starting the server. Returns
// null when the token file hasn't been written yet (panel never started) or is
// unreadable — status is read-only and must not mint a token of its own.
function readPanelUrl(home: string, cfg: ReturnType<typeof effectiveConfig>): string | null {
  const file = panelTokenPath(home);
  if (!existsSync(file)) return null;
  let token: string;
  try {
    token = readFileSync(file, 'utf8').trim();
  } catch {
    return null;
  }
  if (!token) return null;
  const bind = cfg.panel?.bind ?? '127.0.0.1';
  const port = cfg.panel?.port ?? 7777;
  return `http://${panelHost(bind)}:${port}/?token=${token}`;
}

// 0.0.0.0 isn't browsable, so when the panel is LAN-exposed show a reachable
// host (a LAN IP, else localhost). Mirrors the rule in src/panel/server.ts.
function panelHost(bind: string): string {
  if (bind !== '0.0.0.0') return bind;
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return 'localhost';
}

function listInstalled(home: string): Array<{ name: string }> {
  const seen = new Set<string>();
  const out: Array<{ name: string }> = [];
  for (const { folder } of extensionFolders(home)) {
    try {
      const m = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')) as {
        name?: string;
      };
      if (m.name && !seen.has(m.name)) {
        seen.add(m.name);
        out.push({ name: m.name });
      }
    } catch {
      /* ignore */
    }
  }
  return out;
}
