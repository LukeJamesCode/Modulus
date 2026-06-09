// System routes: aggregated dashboard state and the daemon lifecycle controls.
//
// In-process the panel IS the daemon, so the Dashboard's three buttons map to:
//   start   — no-op (it's already running; we are serving this page)
//   stop    — graceful shutdown via the host's onStop hook (the UI then shows
//             disconnected)
//   restart — host re-execs a fresh daemon after this one releases the pid
//             (onRestart); the browser auto-reconnects
// The proactive toggle is an in-memory flag surfaced in /api/state.

import { readJson, sendJson } from '../http.js';
import type { RouteModule } from '../router.js';
import { buildState } from '../state.js';
import type { PanelDeps, PanelRuntime } from '../types.js';

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
      if (deps.onStop) {
        // After the response flushes, hand off to the host's graceful shutdown.
        setTimeout(() => deps.onStop?.(), 100).unref();
      } else {
        deps.log.warn('panel stop requested but no onStop hook');
      }
      return true;
    }

    if (path === '/api/agent/restart' && method === 'POST') {
      sendJson(res, 200, { ok: true });
      if (deps.onRestart) {
        setTimeout(() => deps.onRestart?.(), 100).unref();
      } else {
        deps.log.warn('panel restart requested but no onRestart hook');
      }
      return true;
    }

    if (path === '/api/agent/proactive' && method === 'POST') {
      const { on } = await readJson<{ on?: boolean }>(req);
      runtime.proactive = !!on;
      sendJson(res, 200, { ok: true, proactive: runtime.proactive });
      return true;
    }

    return false;
  };
}
