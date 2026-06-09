// Panel auth: a single bearer token gates the JSON/SSE API.
//
// The panel binds to loopback by default, but a token is required regardless so
// another local process can't drive the agent just by hitting the port. Static
// assets stay open (they carry no secrets); only `/api/*` is gated. The browser
// obtains the token from the `?token=` link printed at startup, stashes it in
// localStorage, and replays it as `x-modulus-token` (or `Authorization:
// Bearer`); EventSource can't set headers, so GET SSE routes accept `?token=`.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { ensurePrivateFile } from '../cli/config-store.js';
import { panelTokenPath } from '../cli/daemon.js';

// Content-Security-Policy for the served HTML. The UI has no build step: React,
// Babel-standalone and marked load from unpkg and Babel transpiles the .jsx in
// the browser (hence 'unsafe-eval'); components use inline style attributes
// (hence style-src 'unsafe-inline'). Everything else is locked to same-origin.
export const PANEL_CSP =
  "default-src 'self'; " +
  "script-src 'self' 'unsafe-eval' https://unpkg.com; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; " +
  "font-src 'self'; " +
  "connect-src 'self'; " +
  "base-uri 'none'; " +
  "form-action 'self'";

// Read the panel token, generating and persisting one (owner-only) on first
// start. base64url, 32 bytes — long enough that brute force over the network is
// hopeless and short enough to paste.
export function loadOrCreatePanelToken(home: string): string {
  const file = panelTokenPath(home);
  if (existsSync(file)) {
    try {
      const existing = readFileSync(file, 'utf8').trim();
      if (existing.length >= 24) return existing;
    } catch {
      /* unreadable — fall through and regenerate */
    }
  }
  const token = randomBytes(32).toString('base64url');
  writeFileSync(file, token, { encoding: 'utf8', mode: 0o600 });
  ensurePrivateFile(file);
  return token;
}

// Extract the presented token from a request: Authorization: Bearer wins, then
// the x-modulus-token header, then the ?token= query param (the only option
// EventSource has).
export function requestToken(req: IncomingMessage, url: URL): string {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const header = req.headers['x-modulus-token'];
  if (typeof header === 'string' && header) return header;
  return url.searchParams.get('token') ?? '';
}

// Constant-time comparison so a wrong guess can't be refined by timing.
export function tokensMatch(presented: string | undefined, expected: string): boolean {
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
