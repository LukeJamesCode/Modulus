// In-process web panel.
//
// Unlike Gurney's gurney-frontend (a separate process that rebuilt the whole
// stack and shelled out to the CLI), this runs inside the daemon and is handed
// the live engine. `createPanel(deps)` starts an HTTP server that serves the
// browser UI from ./web and a token-gated JSON/SSE API under /api. Route
// families are split into ./routes/* as they are ported; today /api/state is
// live and the rest 404 until their route module lands.

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from '../storage/db.js';
import type { Logger } from '../util/log.js';
import type { ModulusConfig } from '../cli/config-store.js';
import { loadOrCreatePanelToken, PANEL_CSP, requestToken, tokensMatch } from './auth.js';
import { buildState } from './state.js';

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), 'web');

// The live handles the panel borrows from the daemon. Engine handles
// (orchestrator, agent runtime, etc.) are added to this as their route families
// are ported; the current set is what /api/state needs plus the re-exec inputs.
export interface PanelDeps {
  db: DB;
  log: Logger;
  home: string;
  config: ModulusConfig;
  extensionRoots: readonly string[];
  // argv[1] + execArgv of the daemon, so a panel-triggered restart can re-exec
  // the same entrypoint under the same loader (tsx in dev, node in prod).
  cliEntry?: string;
  execArgv?: readonly string[];
}

export interface PanelHandle {
  url: string;
  token: string;
  close(): Promise<void>;
}

// Shared per-request mutable panel state that outlives a single request (e.g.
// the proactive toggle). Kept here rather than in the DB so a flip is instant.
interface PanelRuntime {
  proactive: boolean;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

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

async function handleApi(
  deps: PanelDeps,
  runtime: PanelRuntime,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const path = url.pathname;
  const method = req.method ?? 'GET';
  try {
    if (path === '/api/state' && method === 'GET') {
      return sendJson(
        res,
        200,
        await buildState({
          db: deps.db,
          home: deps.home,
          extensionRoots: deps.extensionRoots,
          proactive: runtime.proactive,
        }),
      );
    }
    // Other route families (chat, agents, modules, settings, system) are ported
    // in subsequent commits; until then they 404.
    return sendJson(res, 404, { error: 'unknown route' });
  } catch (e) {
    deps.log.warn('panel api error', {
      path,
      error: e instanceof Error ? e.message : String(e),
    });
    return sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
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

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      // Static assets stay open (no secrets); every API call needs the token,
      // even on loopback, so another local process can't drive the agent.
      if (!tokensMatch(requestToken(req, url), token)) {
        return sendJson(res, 401, { error: 'unauthorized' });
      }
      void handleApi(deps, runtime, req, res, url);
      return;
    }
    serveStatic(res, url.pathname);
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
