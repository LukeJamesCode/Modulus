// Codex token store + auto-refresh.
//
// Secrets live in Modulus's `extension_settings` table (same place every other
// extension keeps its OAuth material), reached through `host.settings`. This
// keeps Codex auth inside ~/.modulus with the rest of the user's secrets — NOT
// in ~/.codex — so `modulus` owns the lifecycle and a future `modulus backup`
// captures it. The auth flow writes the initial token set; this module reads it
// back, refreshes when it's near expiry, and persists the rotated tokens.

import type { Host } from '../../../src/core/modules.js';
import { refreshTokens, extractAccountId, type TokenSet } from './oauth.js';

export class CodexNotAuthedError extends Error {
  constructor() {
    super('Codex is not configured. Run `modulus auth modulus-codex` first.');
    this.name = 'CodexNotAuthedError';
  }
}

export interface StoredCodex extends TokenSet {
  accountId: string | null;
}

// Settings keys — kept in one place so auth.ts, the store, and logout all agree.
export const KEYS = {
  access: 'codex_access_token',
  refresh: 'codex_refresh_token',
  id: 'codex_id_token',
  expiresAt: 'codex_expires_at',
  accountId: 'codex_account_id',
} as const;

export function readTokens(host: Host): StoredCodex | null {
  const accessToken = host.settings.get<string>(KEYS.access, '');
  const refreshToken = host.settings.get<string>(KEYS.refresh, '');
  if (!accessToken || !refreshToken) return null;
  const idToken = host.settings.get<string>(KEYS.id, '');
  const expiresAt = Number(host.settings.get<number>(KEYS.expiresAt, 0)) || 0;
  const accountId = host.settings.get<string>(KEYS.accountId, '') || null;
  const out: StoredCodex = { accessToken, refreshToken, expiresAt, accountId };
  if (idToken) out.idToken = idToken;
  return out;
}

export function writeTokens(host: Host, tokens: StoredCodex): void {
  host.settings.set(KEYS.access, tokens.accessToken);
  host.settings.set(KEYS.refresh, tokens.refreshToken);
  host.settings.set(KEYS.expiresAt, tokens.expiresAt);
  if (tokens.idToken) host.settings.set(KEYS.id, tokens.idToken);
  if (tokens.accountId) host.settings.set(KEYS.accountId, tokens.accountId);
}

export function clearTokens(host: Host): void {
  // No delete on the settings API; blanking is enough — readTokens() treats an
  // empty access/refresh as "not authed".
  host.settings.set(KEYS.access, '');
  host.settings.set(KEYS.refresh, '');
  host.settings.set(KEYS.id, '');
  host.settings.set(KEYS.expiresAt, 0);
  host.settings.set(KEYS.accountId, '');
}

// Serialize refresh so two concurrent handoffs don't both hit the token
// endpoint and clobber each other's rotated refresh_token. Modulus is a single
// process, so an in-module promise chain is sufficient (no cross-process lock
// needed).
let refreshGate: Promise<unknown> = Promise.resolve();

// Refresh this many ms before the real expiry so an in-flight request never
// races the deadline.
const REFRESH_MARGIN_MS = 60_000;

export interface ValidToken {
  accessToken: string;
  accountId: string | null;
}

// Return a usable access token, refreshing transparently when it's expired or
// about to be. Pass `force: true` to refresh regardless of expiry — used when a
// call 401s mid-flight (the token was revoked or expired between the pre-check
// and the request). Throws CodexNotAuthedError when nothing is stored.
export async function getValidAccessToken(
  host: Host,
  deps?: { fetchImpl?: typeof fetch; now?: () => number; force?: boolean },
): Promise<ValidToken> {
  const now = (deps?.now ?? Date.now)();
  const run = async (): Promise<ValidToken> => {
    const stored = readTokens(host);
    if (!stored) throw new CodexNotAuthedError();
    if (!deps?.force && stored.expiresAt - REFRESH_MARGIN_MS > now) {
      return { accessToken: stored.accessToken, accountId: stored.accountId };
    }
    host.log.info('refreshing Codex access token');
    const refreshArgs: Parameters<typeof refreshTokens>[0] = { prev: stored };
    if (deps?.fetchImpl) refreshArgs.fetchImpl = deps.fetchImpl;
    if (deps?.now) refreshArgs.now = deps.now;
    const next = await refreshTokens(refreshArgs);
    // Re-derive the account id if the refresh handed back a new id_token;
    // otherwise keep the one we already had.
    const accountId = extractAccountId(next.idToken) ?? stored.accountId;
    writeTokens(host, { ...next, accountId });
    return { accessToken: next.accessToken, accountId };
  };
  // Chain onto the gate, but isolate failures so one rejected refresh doesn't
  // poison every later caller.
  const result = refreshGate.then(run, run);
  refreshGate = result.catch(() => undefined);
  return result;
}
