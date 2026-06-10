// Loopback OAuth callback server for this module's Google auth flow. Listens
// for the browser redirect, verifies `state` to defend against a stray/forged
// callback, and resolves the authorization `code`.
//
// Vendored into the module (modulus-codex carries its own copy) rather than
// imported from core: a shipped module's folder is its whole world — the
// installed copy under ~/.modulus/modules has no ../../src to import from.

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface OAuthCallbackServer {
  actualPort: Promise<number>;
  code: Promise<string>;
  close: () => void;
}

export interface OAuthCallbackOptions {
  bindAddr: string;
  port: number;
  expectedState: string;
  // Path the redirect lands on, e.g. '/callback' or '/auth/callback'.
  callbackPath: string;
  // Plain-text page shown in the browser once the code is captured.
  completionMessage: string;
  // Error message when the provider redirects without a code (and no error).
  noCodeError: string;
  timeoutMs?: number;
}

export function setupOAuthCallbackServer(opts: OAuthCallbackOptions): OAuthCallbackServer {
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  let resolvePort!: (p: number) => void;
  let rejectPort!: (e: Error) => void;
  let resolveCode!: (c: string) => void;
  let rejectCode!: (e: Error) => void;

  const portP = new Promise<number>((res, rej) => {
    resolvePort = res;
    rejectPort = rej;
  });
  const codeP = new Promise<string>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });

  const timer = setTimeout(() => {
    server.close();
    rejectCode(new Error('OAuth timed out (5 minutes)'));
  }, timeoutMs);
  timer.unref?.();

  const server = createServer((req, res) => {
    if (!req.url?.startsWith(opts.callbackPath)) {
      res.statusCode = 404;
      res.end();
      return;
    }
    const addr = server.address() as AddressInfo;
    const url = new URL(req.url, `http://localhost:${addr.port}`);
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    const state = url.searchParams.get('state');
    res.statusCode = 200;
    res.setHeader('content-type', 'text/plain');
    res.end(opts.completionMessage);
    clearTimeout(timer);
    server.close();
    if (state !== opts.expectedState) rejectCode(new Error('OAuth state mismatch'));
    else if (code) resolveCode(code);
    else rejectCode(new Error(error ?? opts.noCodeError));
  });

  server.on('error', (e) => {
    clearTimeout(timer);
    const err = e instanceof Error ? e : new Error(String(e));
    rejectPort(err);
    rejectCode(err);
  });

  server.listen(opts.port, opts.bindAddr, () => {
    resolvePort((server.address() as AddressInfo).port);
  });

  return {
    actualPort: portP,
    code: codeP,
    close: () => {
      clearTimeout(timer);
      server.close();
    },
  };
}
