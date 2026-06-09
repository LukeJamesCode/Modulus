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

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { freemem, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from '../../storage/db.js';
import type { ModulusConfig } from '../../cli/config-store.js';
import { metricsFilePath } from '../../cli/daemon.js';
import { collectDoctorChecks } from '../../cli/doctor.js';
import { parseCron, nextFireAfter } from '../../core/cron.js';
import { readMetrics } from '../../core/metrics.js';
import { createPrefsStore, formatWindow } from '../../core/prefs.js';
import { readJson, sendJson } from '../http.js';
import type { RouteModule } from '../router.js';
import { buildState } from '../state.js';
import type { PanelDeps, PanelRuntime } from '../types.js';

// docs/ lives at the repo root; this file is src/panel/routes/system.ts.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function humanize(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
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
        WHERE user_id IN (${placeholders})
        ORDER BY last_seen_at DESC LIMIT 1`,
    )
    .get(...cfg.telegram.allowedIds) as { chatId: number } | undefined;
  return row?.chatId ?? fallback;
}

interface SchedulerView {
  configured: boolean;
  proactive?: boolean;
  nowMs?: number;
  jobs?: Array<{ extension: string; name: string; cron: string; nextFireMs: number | null }>;
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
      return { extension: j.extension, name: j.name, cron: j.cron, nextFireMs };
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
  return {
    hasMetrics: true,
    agentRunning: true,
    startedAt: metrics.startedAt,
    metricsAt: metrics.updatedAt,
    uptimeMs: metrics.uptimeMs,
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

export function createSystemRoutes(deps: PanelDeps, runtime: PanelRuntime): RouteModule {
  return async ({ req, res, path, method }) => {
    if (path === '/api/state' && method === 'GET') {
      sendJson(
        res,
        200,
        await buildState({
          db: deps.db,
          home: deps.home,
          extensionRoots: deps.extensionRoots,
          proactive: runtime.proactive,
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

    return false;
  };
}
