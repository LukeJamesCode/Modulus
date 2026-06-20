// Computer Use live monitor. Read-only window onto modulus-computer-use: it
// tails the module's audit tables (computer_use_sessions / _steps) so the panel
// shows the running session's screenshots and action log, and offers a Stop
// that flips the stop_requested flag the loop polls. Start happens from chat
// (the start_computer_use tool) or Telegram; this surface watches and stops.
//
// The module owns those tables via its own migration, so everything here guards
// on their existence and no-ops cleanly when the module isn't enabled. The loop
// runs in the daemon (in-process panel), so reading the live DB is enough — no
// cross-process plumbing.

import { createReadStream, existsSync, statSync } from 'node:fs';
import { sendJson, readJson, writeSseHead, sse } from '../http.js';
import type { RouteModule } from '../router.js';
import type { PanelDeps } from '../types.js';
import type { DB } from '../../storage/db.js';

interface SessionRow {
  id: number;
  goal: string;
  status: string;
  summary: string | null;
  started_at: number;
  finished_at: number | null;
}

interface StepRow {
  id: number;
  step_no: number;
  action: string;
  rationale: string | null;
  foreground: string | null;
  screenshot: string | null;
  outcome: string;
  detail: string | null;
  created_at: number;
}

function tablesExist(db: DB): boolean {
  const row = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='computer_use_sessions'`,
    )
    .get();
  return !!row;
}

function stepDto(s: StepRow): Record<string, unknown> {
  return {
    id: s.id,
    stepNo: s.step_no,
    action: s.action,
    rationale: s.rationale,
    foreground: s.foreground,
    outcome: s.outcome,
    detail: s.detail,
    createdAt: s.created_at,
    // The browser loads the image lazily; the route streams the PNG by step id.
    shotUrl: s.screenshot ? `/api/computer/shot?step=${s.id}` : null,
  };
}

export function createComputerRoutes(deps: PanelDeps): RouteModule {
  const { db } = deps;

  return (ctx) => {
    if (!ctx.path.startsWith('/api/computer/')) return false;

    if (!tablesExist(db)) {
      // Module not enabled (no tables yet). Tell the UI to show the empty state.
      if (ctx.path === '/api/computer/state' && ctx.method === 'GET') {
        sendJson(ctx.res, 200, { available: false, active: null, recent: [] });
        return true;
      }
      sendJson(ctx.res, 200, { available: false });
      return true;
    }

    // Snapshot: the active session (if any) and recent history.
    if (ctx.path === '/api/computer/state' && ctx.method === 'GET') {
      const active = db
        .prepare(
          `SELECT id, goal, status, summary, started_at, finished_at
             FROM computer_use_sessions WHERE status = 'running' ORDER BY id DESC LIMIT 1`,
        )
        .get() as SessionRow | undefined;
      const recent = db
        .prepare(
          `SELECT id, goal, status, summary, started_at, finished_at
             FROM computer_use_sessions ORDER BY id DESC LIMIT 15`,
        )
        .all() as SessionRow[];
      sendJson(ctx.res, 200, { available: true, active: active ?? null, recent });
      return true;
    }

    // Stream a session's steps + status over SSE (unnamed frames for EventSource).
    if (ctx.path === '/api/computer/stream' && ctx.method === 'GET') {
      const idParam = ctx.url.searchParams.get('sessionId');
      let sessionId = idParam ? Number.parseInt(idParam, 10) : NaN;
      if (!Number.isFinite(sessionId)) {
        const latest = db
          .prepare(`SELECT id FROM computer_use_sessions ORDER BY id DESC LIMIT 1`)
          .get() as { id: number } | undefined;
        sessionId = latest?.id ?? 0;
      }
      writeSseHead(ctx.res);

      let lastStepId = 0;
      let lastStatus = '';
      const tick = (): void => {
        try {
          const session = db
            .prepare(
              `SELECT id, goal, status, summary, started_at, finished_at
                 FROM computer_use_sessions WHERE id = ?`,
            )
            .get(sessionId) as SessionRow | undefined;
          if (!session) return;
          const steps = db
            .prepare(
              `SELECT id, step_no, action, rationale, foreground, screenshot, outcome, detail, created_at
                 FROM computer_use_steps WHERE session_id = ? AND id > ? ORDER BY id ASC`,
            )
            .all(sessionId, lastStepId) as StepRow[];
          for (const s of steps) {
            lastStepId = s.id;
            sse(ctx.res, null, { kind: 'step', sessionId, step: stepDto(s) });
          }
          if (session.status !== lastStatus) {
            lastStatus = session.status;
            sse(ctx.res, null, {
              kind: 'status',
              sessionId,
              status: session.status,
              goal: session.goal,
              summary: session.summary,
            });
          }
        } catch {
          /* transient read error; next tick retries */
        }
      };
      tick();
      const timer = setInterval(tick, 800);
      timer.unref?.();
      const stop = (): void => {
        clearInterval(timer);
        try {
          ctx.res.end();
        } catch {
          /* already closed */
        }
      };
      ctx.req.on('close', stop);
      ctx.req.on('error', stop);
      return true;
    }

    // Stream one step's screenshot PNG. The path comes from our own DB row keyed
    // by an integer step id, so there's no user-supplied path to contain.
    if (ctx.path === '/api/computer/shot' && ctx.method === 'GET') {
      const stepId = Number.parseInt(ctx.url.searchParams.get('step') ?? '', 10);
      if (!Number.isFinite(stepId)) {
        sendJson(ctx.res, 400, { error: 'bad step id' });
        return true;
      }
      const row = db
        .prepare(`SELECT screenshot FROM computer_use_steps WHERE id = ?`)
        .get(stepId) as { screenshot: string | null } | undefined;
      const path = row?.screenshot;
      if (!path || !path.toLowerCase().endsWith('.png') || !existsSync(path) || !statSync(path).isFile()) {
        sendJson(ctx.res, 404, { error: 'no screenshot' });
        return true;
      }
      ctx.res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
      createReadStream(path).pipe(ctx.res);
      return true;
    }

    // Stop the running session (panel Stop). Flips the flag the loop polls.
    if (ctx.path === '/api/computer/stop' && ctx.method === 'POST') {
      void readJson(ctx.req).catch(() => ({}));
      const info = db
        .prepare(`UPDATE computer_use_sessions SET stop_requested = 1 WHERE status = 'running'`)
        .run();
      sendJson(ctx.res, 200, { ok: true, stopped: info.changes });
      return true;
    }

    return false;
  };
}
