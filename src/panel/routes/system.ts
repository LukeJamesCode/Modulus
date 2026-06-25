// System routes: dashboard state, daemon lifecycle, and the read-only System
// tab projections (metrics, scheduler timeline, conversation history, doctor,
// docs).
//
// In-process the panel IS the daemon, so the Dashboard's three buttons map to:
//   start   — no-op (already running; we are serving this page)
//   stop    — graceful shutdown via the host's onStop hook
//   restart — host re-execs a fresh daemon after this one releases the pid
// The read-only projections use the daemon's live db/scheduler directly, no
// second runtime and no DB polling.

import {
  createReadStream,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { freemem, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from '../../storage/db.js';
import type { ModulusConfig } from '../../cli/config-store.js';
import { logFilePath, metricsFilePath } from '../../cli/daemon.js';
import { collectDoctorChecks } from '../../cli/doctor.js';
import { REAL_TELEGRAM_CHAT_SQL } from '../../core/agents.js';
import { parseCron, nextFireAfter } from '../../core/cron.js';
import { describeCron } from '../../core/schedule-parse.js';
import { readMetrics } from '../../core/metrics.js';
import { createUpdateChecker, type DesktopUpdateState } from '../../core/update-check.js';
import { createPrefsStore, formatWindow } from '../../core/prefs.js';
import { readJson, sendJson, sse, writeSseHead } from '../http.js';
import type { RouteModule } from '../router.js';
import { runModulus } from '../spawn.js';
import { buildState } from '../state.js';
import type { PanelDeps, PanelRuntime } from '../types.js';

// docs/ lives at the repo root; this file is src/panel/routes/system.ts.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// Files the desktop shell and the daemon use to coordinate updates (alongside
// modulus.pid / the panel-locator files in ~/.modulus). The shell WRITES its
// downloaded-update status here; the daemon WRITES the apply request the shell
// watches for. Names are shared with desktop/ModulusDesktop/UpdateChecker.cs.
const DESKTOP_UPDATE_STATUS_FILE = 'desktop-update.json';
const DESKTOP_APPLY_UPDATE_FILE = 'desktop-apply-update';

function humanize(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// Read the desktop shell's downloaded-update status file, if it wrote one.
// Absent/garbled → null (the version checker then falls back to the releases
// API). Never throws — an update check must not break the System tab.
function readDesktopUpdateState(home: string): DesktopUpdateState | null {
  try {
    const raw = readFileSync(join(home, DESKTOP_UPDATE_STATUS_FILE), 'utf8');
    const j = JSON.parse(raw) as { hasUpdate?: unknown; version?: unknown };
    return {
      hasUpdate: j.hasUpdate === true,
      version: typeof j.version === 'string' ? j.version : null,
    };
  } catch {
    return null;
  }
}

// The owner chat used for proactive prefs: the most recently seen chat of an
// allowlisted user, falling back to the first allowlisted id.
function ownerChatId(db: DB, cfg: ModulusConfig): number | null {
  const fallback = cfg.telegram.allowedIds[0];
  if (fallback === undefined) return null;
  const placeholders = cfg.telegram.allowedIds.map(() => '?').join(', ');
  const row = db
    .prepare(
      `SELECT chat_id AS chatId FROM telegram_chats
        WHERE user_id IN (${placeholders}) AND ${REAL_TELEGRAM_CHAT_SQL}
        ORDER BY last_seen_at DESC LIMIT 1`,
    )
    .get(...cfg.telegram.allowedIds) as { chatId: number } | undefined;
  return row?.chatId ?? fallback;
}

interface SchedulerView {
  configured: boolean;
  proactive?: boolean;
  nowMs?: number;
  jobs?: Array<{
    module: string;
    name: string;
    cron: string;
    human: string;
    nextFireMs: number | null;
  }>;
  quietWindow?: string | null;
  pausedUntilMs?: number | null;
  quiet?: { quiet: boolean; reason: string | null; until: number | null };
}

// Read-only projection of the live scheduler: registered cron jobs and their
// next fire time (computed with the same parseCron the scheduler uses, in the
// process-local TZ), plus the owner chat's quiet-window / snooze state.
function schedulerView(deps: PanelDeps, runtime: PanelRuntime): SchedulerView {
  const cfg = deps.config;
  if (cfg.telegram.allowedIds.length === 0) return { configured: false };
  const chatId = ownerChatId(deps.db, cfg);
  if (chatId === null) return { configured: false };
  const now = new Date();
  const jobs = deps.scheduler
    .list()
    .map((j) => {
      let nextFireMs: number | null = null;
      try {
        nextFireMs = nextFireAfter(parseCron(j.cron), now).getTime();
      } catch {
        nextFireMs = null; // unparseable cron — surface the job without a time
      }
      return { module: j.module, name: j.name, cron: j.cron, human: describeCron(j.cron), nextFireMs };
    })
    .sort((a, b) => (a.nextFireMs ?? Infinity) - (b.nextFireMs ?? Infinity));
  const prefs = createPrefsStore(deps.db);
  const p = prefs.get(chatId);
  const q = prefs.isQuiet(chatId, now);
  return {
    configured: true,
    proactive: runtime.proactive,
    nowMs: now.getTime(),
    jobs,
    quietWindow: formatWindow(p.quietStartMinute, p.quietEndMinute),
    pausedUntilMs: p.pausedUntilMs,
    quiet: { quiet: q.quiet, reason: q.reason ?? null, until: q.until ?? null },
  };
}

// Snooze (or clear) proactive nudges for the owner chat. The daemon reads
// chat_prefs on every dispatch, so this takes effect without a restart.
function snoozeProactive(
  deps: PanelDeps,
  ms: number,
): { ok: boolean; pausedUntilMs: number | null } {
  const chatId = ownerChatId(deps.db, deps.config);
  if (chatId === null) return { ok: false, pausedUntilMs: null };
  const prefs = createPrefsStore(deps.db);
  const until = ms && ms > 0 ? Date.now() + ms : null;
  prefs.setPausedUntil(chatId, until);
  return { ok: true, pausedUntilMs: until };
}

function metricsView(deps: PanelDeps): unknown {
  const metrics = readMetrics(metricsFilePath(deps.home));
  const totalGb = Math.round((totalmem() / 1024 ** 3) * 10) / 10;
  const freeGb = Math.round((freemem() / 1024 ** 3) * 10) / 10;
  // The daemon serving the panel is the agent, so it is always running.
  if (!metrics) {
    return { hasMetrics: false, agentRunning: true, ram: { totalGb, freeGb } };
  }
  const s = metrics.scheduler;
  const hits = s.cache?.hits ?? 0;
  const misses = s.cache?.misses ?? 0;
  const total = hits + misses;
  const tripwireDenials = Object.entries(metrics.moduleTripwireDenials ?? {})
    .filter(([, n]) => n > 0)
    .map(([module, count]) => ({ module, count }));
  return {
    hasMetrics: true,
    agentRunning: true,
    startedAt: metrics.startedAt,
    metricsAt: metrics.updatedAt,
    uptimeMs: metrics.uptimeMs,
    tripwireDenials,
    scheduler: {
      jobsRegistered: s.jobsRegistered,
      ticks: s.ticks,
      lastTickAt: s.lastTickAt,
      nudgesSent: s.nudgesSent,
      nudgesDropped: s.nudgesDropped,
    },
    cache: {
      hits,
      misses,
      size: s.cache?.size ?? 0,
      hitRate: total > 0 ? Math.round((hits / total) * 100) : null,
    },
    ram: { totalGb, freeGb },
  };
}

interface ConversationRow {
  id: number;
  chatId: number;
  startedAt: number;
  endedAt: number | null;
  messageCount: number;
  lastAt: number | null;
  preview: string | null;
}

function listConversations(db: DB): {
  conversations: Array<ConversationRow & { current: boolean }>;
} {
  const convs = db
    .prepare(
      `SELECT c.id AS id, c.telegram_chat_id AS chatId, c.started_at AS startedAt,
              c.ended_at AS endedAt, COUNT(m.id) AS messageCount, MAX(m.created_at) AS lastAt,
              (SELECT content FROM messages
                 WHERE conversation_id = c.id AND role = 'user'
                 ORDER BY id LIMIT 1) AS preview
         FROM conversations c
         LEFT JOIN messages m ON m.conversation_id = c.id
        GROUP BY c.id
        ORDER BY COALESCE(MAX(m.created_at), c.started_at) DESC
        LIMIT 50`,
    )
    .all() as ConversationRow[];
  const current = db
    .prepare(
      `SELECT current_conversation_id AS id FROM telegram_chats
        WHERE current_conversation_id IS NOT NULL`,
    )
    .all() as Array<{ id: number }>;
  const currentSet = new Set(current.map((r) => r.id));
  return { conversations: convs.map((c) => ({ ...c, current: currentSet.has(c.id) })) };
}

function conversationMessages(db: DB, id: number): unknown {
  const conv = db
    .prepare(
      `SELECT id, telegram_chat_id AS chatId, started_at AS startedAt, ended_at AS endedAt
         FROM conversations WHERE id = ?`,
    )
    .get(id) as
    | { id: number; chatId: number; startedAt: number; endedAt: number | null }
    | undefined;
  if (!conv) return { error: 'conversation not found' };
  // Cap at the last 500 messages; tool rows kept so the transcript matches what
  // the model saw.
  const messages = db
    .prepare(
      `SELECT role, content, tool_name AS toolName, tokens, created_at AS createdAt
         FROM messages WHERE conversation_id = ? ORDER BY id LIMIT 500`,
    )
    .all(id);
  const summaryRow = db
    .prepare(`SELECT summary FROM session_memory WHERE conversation_id = ?`)
    .get(id) as { summary: string } | undefined;
  return { conversation: conv, messages, summary: summaryRow?.summary ?? null };
}

function readDocs(): unknown {
  const docsDir = join(REPO_ROOT, 'docs');
  if (!existsSync(docsDir)) return { ok: true, docs: [] };
  const files = readdirSync(docsDir)
    .filter((f) => f.endsWith('.md'))
    .sort();
  const docs = files.map((f) => {
    const content = readFileSync(join(docsDir, f), 'utf8');
    const titleMatch = content.match(/^#\s+(.+)$/m);
    const title = titleMatch ? titleMatch[1] : f.replace('.md', '').replace(/-/g, ' ');
    return { filename: f, title, content };
  });
  return { ok: true, docs };
}

function tailLines(file: string, max = 400): string[] {
  if (!existsSync(file)) return [];
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-max);
  } catch {
    return [];
  }
}

// Follow the daemon's own log file: replay the current tail, then poll for
// appended bytes (fs.watch is unreliable across platforms; a 1.5s stat is
// cheap). A shrinking file means rotation/truncation — restart from zero.
// Frames are unnamed for EventSource.onmessage.
function streamLogs(deps: PanelDeps, req: IncomingMessage, res: ServerResponse): void {
  const file = logFilePath(deps.home);
  writeSseHead(res);
  let offset = 0;
  try {
    offset = existsSync(file) ? statSync(file).size : 0;
  } catch {
    offset = 0;
  }
  for (const line of tailLines(file)) sse(res, null, line);
  const tick = setInterval(() => {
    try {
      if (!existsSync(file)) return;
      const size = statSync(file).size;
      if (size < offset) offset = 0;
      if (size > offset) {
        const stream = createReadStream(file, { start: offset, end: size - 1, encoding: 'utf8' });
        let buf = '';
        stream.on('data', (c) => (buf += c));
        stream.on('end', () => {
          for (const line of buf.split('\n').filter(Boolean)) sse(res, null, line);
        });
        offset = size;
      }
    } catch {
      /* ignore transient read errors */
    }
  }, 1500);
  tick.unref?.();
  // Comment frames keep proxies from idling the connection out.
  const keepAlive = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* client gone */
    }
  }, 20_000);
  keepAlive.unref?.();
  req.on('close', () => {
    clearInterval(tick);
    clearInterval(keepAlive);
  });
}

export function createSystemRoutes(deps: PanelDeps, runtime: PanelRuntime): RouteModule {
  // One process-lived update checker (TTL-cached, so panel polling never hammers
  // the GitHub API). Desktop installs check the release channel + the shell's
  // status file; git checkouts compare the local commit to origin.
  const isDesktop = process.env.MODULUS_DESKTOP === '1';
  const updateChecker = createUpdateChecker({
    desktop: isDesktop,
    repoRoot: REPO_ROOT,
    ...(process.env.MODULUS_REPO ? { defaultSlug: process.env.MODULUS_REPO } : {}),
    readDesktopState: () => readDesktopUpdateState(deps.home),
  });

  return async ({ req, res, path, method }) => {
    if (path === '/api/state' && method === 'GET') {
      sendJson(
        res,
        200,
        await buildState({
          db: deps.db,
          home: deps.home,
          moduleRoots: deps.moduleRoots,
          proactive: runtime.proactive,
          setupMode: !!deps.setup,
          setupError: deps.setup?.lastError() ?? null,
        }),
      );
      return true;
    }

    if (path === '/api/agent/start' && method === 'POST') {
      // The daemon serving this panel is already running; nothing to start.
      sendJson(res, 200, { ok: true, running: true });
      return true;
    }

    if (path === '/api/agent/stop' && method === 'POST') {
      sendJson(res, 200, { ok: true });
      if (deps.onStop) setTimeout(() => deps.onStop?.(), 100).unref();
      else deps.log.warn('panel stop requested but no onStop hook');
      return true;
    }

    if (path === '/api/agent/restart' && method === 'POST') {
      sendJson(res, 200, { ok: true });
      if (deps.onRestart) setTimeout(() => deps.onRestart?.(), 100).unref();
      else deps.log.warn('panel restart requested but no onRestart hook');
      return true;
    }

    if (path === '/api/agent/proactive' && method === 'POST') {
      const { on } = await readJson<{ on?: boolean }>(req);
      runtime.proactive = !!on;
      sendJson(res, 200, { ok: true, proactive: runtime.proactive });
      return true;
    }

    if (path === '/api/metrics' && method === 'GET') {
      sendJson(res, 200, metricsView(deps));
      return true;
    }

    if (path === '/api/scheduler' && method === 'GET') {
      sendJson(res, 200, schedulerView(deps, runtime));
      return true;
    }

    if (path === '/api/scheduler/snooze' && method === 'POST') {
      const { ms } = await readJson<{ ms?: number }>(req);
      sendJson(res, 200, snoozeProactive(deps, typeof ms === 'number' ? ms : 0));
      return true;
    }

    if (path === '/api/conversations' && method === 'GET') {
      sendJson(res, 200, listConversations(deps.db));
      return true;
    }

    const convMessages = /^\/api\/conversations\/(\d+)\/messages$/.exec(path);
    if (convMessages && method === 'GET') {
      sendJson(res, 200, conversationMessages(deps.db, Number(convMessages[1])));
      return true;
    }

    if (path === '/api/doctor' && method === 'GET') {
      const checks = await collectDoctorChecks();
      sendJson(res, 200, {
        checks: checks.map((c) => ({
          id: c.name,
          label: humanize(c.name),
          status: c.ok ? 'pass' : 'fail',
          detail: c.msg,
        })),
      });
      return true;
    }

    if (path === '/api/docs' && method === 'GET') {
      sendJson(res, 200, readDocs());
      return true;
    }

    if (path === '/api/logs/stream' && method === 'GET') {
      streamLogs(deps, req, res);
      return true;
    }

    // Update availability for the panel's notification + Update button. Cheap
    // (TTL-cached); `?force=1` skips the cache for an explicit "check now".
    if (path === '/api/maintenance/version' && method === 'GET') {
      const force = new URL(req.url ?? '', 'http://localhost').searchParams.has('force');
      sendJson(res, 200, await updateChecker.check(force));
      return true;
    }

    // Desktop "Update" button: the shell has already downloaded the release in
    // the background (Velopack), so applying it is just an app restart. We drop a
    // sentinel file the shell watches for; it stops the daemon and relaunches
    // into the new version. No-op outside the desktop shell.
    if (path === '/api/maintenance/desktop-update/apply' && method === 'POST') {
      // Read at request time (not the creation-time `isDesktop`) so tests that
      // toggle the env per-request, and any late-set env, are honoured.
      if (process.env.MODULUS_DESKTOP !== '1') {
        sendJson(res, 400, { ok: false, error: 'not running under the desktop app' });
        return true;
      }
      try {
        writeFileSync(join(deps.home, DESKTOP_APPLY_UPDATE_FILE), String(Date.now()));
        sendJson(res, 200, { ok: true });
      } catch (e) {
        sendJson(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
      }
      return true;
    }

    // Pull + rebuild via the same `modulus update` the CLI runs. Safe while
    // live: the rebuild lands on disk; we then re-exec a fresh daemon so the new
    // code is actually running (the old in-process one is still serving this
    // response). Under the desktop shell the install is a packaged payload, not a
    // git checkout — the shell's own release updater owns updates there.
    if (path === '/api/maintenance/update' && method === 'POST') {
      if (process.env.MODULUS_DESKTOP === '1') {
        sendJson(res, 409, {
          ok: false,
          command: 'modulus update',
          output:
            'This Modulus runs inside the desktop app, which updates itself.\n' +
            'Updates install automatically; quit and reopen the app to apply one.',
        });
        return true;
      }
      const r = await runModulus(deps, ['update'], 1_800_000);
      const ok = r.code === 0;
      sendJson(res, ok ? 200 : 500, {
        ok,
        code: r.code,
        command: 'modulus update',
        output: r.out + r.err,
        // Tell the panel a restart is coming so it can show "restarting…" and
        // reconnect once the fresh daemon's panel is back up.
        restarting: ok && !!deps.onRestart,
      });
      // Apply the freshly-built code by re-execing after the response flushes.
      if (ok && deps.onRestart) setTimeout(() => deps.onRestart?.(), 250).unref();
      else if (ok && !deps.onRestart) {
        deps.log.warn('update built but no onRestart hook — restart manually to apply');
      }
      return true;
    }

    // `modulus fresh` wipes ~/.modulus — which this in-process daemon holds open
    // (the SQLite file is locked on Windows) — so running it here would corrupt
    // state or fail mid-wipe, and `fresh` itself SIGTERMs this very process. We
    // validate the confirmation and hand the user off to the terminal rather
    // than self-destruct the live daemon. ok:false keeps the UI from treating
    // it as a completed reset.
    if (path === '/api/maintenance/fresh' && method === 'POST') {
      const { confirm } = await readJson<{ confirm?: string }>(req);
      if (confirm !== 'RESET') {
        sendJson(res, 400, { ok: false, error: 'type RESET to confirm a fresh install' });
        return true;
      }
      sendJson(res, 409, {
        ok: false,
        command: 'modulus fresh',
        output:
          'A fresh reset erases ~/.modulus, which this running daemon holds open.\n' +
          'Stop Modulus and run `modulus fresh` from the terminal to reset.',
      });
      return true;
    }

    return false;
  };
}
