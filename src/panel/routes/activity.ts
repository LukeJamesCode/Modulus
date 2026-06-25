// Activity routes: the durable record read two ways.
//
//   GET /api/activity          → newest-first feed (the close-up)
//   GET /api/activity/timeline → time-bucketed counts (the wide shot)
//
// Both read the daemon's live ActivityStore (migration 0039). The feed rows
// carry (refTable, refId) so the browser can drill into existing detail — an
// agent_tasks row opens the run view that's already built. When the store is
// absent (tests that don't wire it) the routes report an empty record rather
// than failing.

import { sendJson } from '../http.js';
import type { RouteModule } from '../router.js';
import type { PanelDeps } from '../types.js';

function intParam(v: string | null, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function createActivityRoutes(deps: PanelDeps): RouteModule {
  return async ({ res, url, path, method }) => {
    if (path === '/api/activity' && method === 'GET') {
      if (!deps.activity) {
        sendJson(res, 200, { items: [] });
        return true;
      }
      const sinceRaw = url.searchParams.get('since');
      const untilRaw = url.searchParams.get('until');
      const kind = url.searchParams.get('kind');
      const items = deps.activity.list({
        ...(sinceRaw !== null ? { since: intParam(sinceRaw, 0) } : {}),
        ...(untilRaw !== null ? { until: intParam(untilRaw, 0) } : {}),
        ...(kind ? { kind } : {}),
        limit: intParam(url.searchParams.get('limit'), 100),
      });
      sendJson(res, 200, { items });
      return true;
    }

    if (path === '/api/activity/timeline' && method === 'GET') {
      if (!deps.activity) {
        sendJson(res, 200, { bucketMs: 60 * 60_000, buckets: [] });
        return true;
      }
      const bucket = url.searchParams.get('bucket') === 'day' ? 'day' : 'hour';
      sendJson(
        res,
        200,
        deps.activity.timeline({ days: intParam(url.searchParams.get('days'), 7), bucket }),
      );
      return true;
    }

    return false;
  };
}
