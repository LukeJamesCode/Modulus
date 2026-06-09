// In-process web panel.
//
// Unlike Gurney's gurney-frontend (a separate process that rebuilt the whole
// stack and shelled out to the CLI), this runs inside the daemon and is handed
// the live engine. `createPanel(deps)` starts an HTTP server that serves the
// browser UI from ./web and a token-gated JSON/SSE API under /api, dispatched
// across the route modules in ./routes. Families are ported incrementally;
// anything unclaimed 404s.

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOrCreatePanelToken, PANEL_CSP, requestToken, tokensMatch } from './auth.js';
import { sendJson } from './http.js';
import { dispatch, type RouteContext, type RouteModule } from './router.js';
import { createAgentRoutes } from './routes/agents.js';
import { createSystemRoutes } from './routes/system.js';
import type { PanelDeps, PanelHandle, PanelRuntime } from './types.js';

export type { PanelDeps, PanelHandle } from './types.js';

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), 'web');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.jsx': 'text/babel; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(res: ServerResponse, pathname: string): void {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const full = normalize(join(WEB_DIR, rel));
  // Path containment: never serve outside ./web.
  if (full !== WEB_DIR && !full.startsWith(WEB_DIR + sep)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  const serveHtml = (file: string): void => {
    res.writeHead(200, {
      'content-type': MIME['.html']!,
      'content-security-policy': PANEL_CSP,
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-cache',
    });
    createReadStream(file).pipe(res);
  };
  if (!existsSync(full) || !statSync(full).isFile()) {
    // SPA fallback: unknown non-asset routes render the app shell.
    const index = join(WEB_DIR, 'index.html');
    if (existsSync(index)) return serveHtml(index);
    res.writeHead(404);
    res.end('not found');
    return;
  }
  const type = MIME[extname(full).toLowerCase()] ?? 'application/octet-stream';
  if (type === MIME['.html']) return serveHtml(full);
  // No build step: .jsx/.js are transpiled in-browser, so revalidate each load
  // rather than letting the browser pin a stale bundle.
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
  createReadStream(full).pipe(res);
}

function lanAddress(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return null;
}

export async function createPanel(deps: PanelDeps): Promise<PanelHandle> {
  const bind = deps.config.panel?.bind ?? '127.0.0.1';
  const port = deps.config.panel?.port ?? 7777;
  const token = loadOrCreatePanelToken(deps.home);
  const runtime: PanelRuntime = { proactive: true };
  const routes: RouteModule[] = [createSystemRoutes(deps, runtime), createAgentRoutes(deps)];

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (!url.pathname.startsWith('/api/')) {
      serveStatic(res, url.pathname);
      return;
    }
    // Static assets stay open (no secrets); every API call needs the token, even
    // on loopback, so another local process can't drive the agent.
    if (!tokensMatch(requestToken(req, url), token)) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }
    const ctx: RouteContext = { req, res, url, path: url.pathname, method: req.method ?? 'GET' };
    void (async () => {
      try {
        if (!(await dispatch(routes, ctx))) sendJson(res, 404, { error: 'unknown route' });
      } catch (e) {
        deps.log.warn('panel api error', {
          path: ctx.path,
          error: e instanceof Error ? e.message : String(e),
        });
        if (!res.headersSent)
          sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
    })();
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(
          new Error(
            `panel port ${port} on ${bind} is already in use — stop the other process or set panel.port.`,
          ),
        );
      } else {
        reject(err);
      }
    });
    server.listen(port, bind, () => resolveListen());
  });

  // Reflect the port the OS actually bound (matters when port is 0).
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  const shown = bind === '0.0.0.0' ? (lanAddress() ?? 'localhost') : bind;
  const url = `http://${shown}:${actualPort}/?token=${token}`;

  return {
    url,
    token,
    close: () =>
      new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
      }),
  };
}
