// OpenAI Codex OAuth (PKCE) — the ChatGPT-subscription auth path.
//
// This mirrors the flow the Codex CLI / OpenClaw use to authenticate against
// the ChatGPT backend with a personal ChatGPT Plus/Pro subscription instead of
// a metered api.openai.com key. The shape is a standard OAuth 2.0
// authorization-code + PKCE dance against auth.openai.com:
//
//   1. Generate a PKCE verifier/challenge and a random `state`.
//   2. Send the user to <AUTHORIZE_URL>?... with the challenge.
//   3. Capture the `code` on a localhost callback (or have the user paste the
//      redirected URL — the common case on a headless Pi over SSH).
//   4. Exchange the code at <TOKEN_URL> for {access, refresh, id_token}.
//   5. Derive the ChatGPT account id from the id_token; it is sent as the
//      `chatgpt-account-id` header on every Codex request.
//
// THE SCOPES TRAP (OpenClaw issue #29418): the access token must be usable
// against the Codex backend, not just an identity token. The Codex authorize
// request carries `id_token_add_organizations=true` (and the simplified-flow
// flag) precisely so the returned token carries the org/account binding the
// backend needs. If you strip those params you get a token that authenticates
// but 401s on every inference call. `probeAccess()` exists to catch exactly
// that during the auth flow rather than at first handoff.
//
// All endpoint/client constants are exported so an advanced user (or a future
// settings override) can adjust them without editing logic if OpenAI rotates
// them.

import { randomBytes, createHash } from 'node:crypto';
import { setupOAuthCallbackServer } from '../../../src/util/oauth-loopback.js';

// Public Codex CLI OAuth client id. This is a public client (no secret); PKCE
// is what protects the exchange.
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
export const TOKEN_URL = 'https://auth.openai.com/oauth/token';
export const OAUTH_SCOPE = 'openid profile email offline_access';
// The Codex CLI binds this fixed port so the redirect URI is stable and
// pre-registered on OpenAI's side. We reuse it for parity.
export const CALLBACK_PORT = 1455;
export const CALLBACK_PATH = '/auth/callback';

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  // Epoch ms when the access token expires.
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface Pkce {
  verifier: string;
  challenge: string;
}

export function createPkce(): Pkce {
  const verifier = base64url(randomBytes(64));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function randomState(): string {
  return randomBytes(16).toString('hex');
}

// ---------------------------------------------------------------------------
// Authorization URL
// ---------------------------------------------------------------------------

export function buildAuthorizeUrl(opts: {
  redirectUri: string;
  challenge: string;
  state: string;
}): string {
  const u = new URL(AUTHORIZE_URL);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', CODEX_CLIENT_ID);
  u.searchParams.set('redirect_uri', opts.redirectUri);
  u.searchParams.set('scope', OAUTH_SCOPE);
  u.searchParams.set('code_challenge', opts.challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  // The two flags that make the token usable against the Codex backend — see
  // the SCOPES TRAP note at the top of the file.
  u.searchParams.set('id_token_add_organizations', 'true');
  u.searchParams.set('codex_cli_simplified_flow', 'true');
  u.searchParams.set('state', opts.state);
  return u.toString();
}

// ---------------------------------------------------------------------------
// Token exchange + refresh
// ---------------------------------------------------------------------------

interface RawTokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
}

function toTokenSet(j: RawTokenResponse, now: number, prev?: TokenSet): TokenSet {
  const accessToken = j.access_token;
  if (!accessToken) throw new Error('token endpoint returned no access_token');
  // Some refresh responses omit refresh_token (the existing one stays valid).
  const refreshToken = j.refresh_token ?? prev?.refreshToken;
  if (!refreshToken) throw new Error('token endpoint returned no refresh_token');
  // Default to 1h if the server doesn't say; refresh logic uses a safety margin.
  const expiresIn = typeof j.expires_in === 'number' ? j.expires_in : 3600;
  const set: TokenSet = {
    accessToken,
    refreshToken,
    expiresAt: now + expiresIn * 1000,
  };
  const idToken = j.id_token ?? prev?.idToken;
  if (idToken) set.idToken = idToken;
  return set;
}

export async function exchangeCode(opts: {
  code: string;
  verifier: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): Promise<TokenSet> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = (opts.now ?? Date.now)();
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: opts.code,
      redirect_uri: opts.redirectUri,
      client_id: CODEX_CLIENT_ID,
      code_verifier: opts.verifier,
    }).toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Codex token exchange failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return toTokenSet((await res.json()) as RawTokenResponse, now);
}

export async function refreshTokens(opts: {
  prev: TokenSet;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): Promise<TokenSet> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = (opts.now ?? Date.now)();
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: opts.prev.refreshToken,
      client_id: CODEX_CLIENT_ID,
      scope: OAUTH_SCOPE,
    }).toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Codex token refresh failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return toTokenSet((await res.json()) as RawTokenResponse, now, opts.prev);
}

// ---------------------------------------------------------------------------
// JWT / account-id extraction
// ---------------------------------------------------------------------------

// Decode (without verifying) the payload of a JWT. We only read claims OpenAI
// already signed and handed us; we never trust this for authorization, so a
// signature check would be ceremony with no security benefit here.
export function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split('.');
  if (parts.length < 2) return null;
  try {
    const json = Buffer.from(parts[1]!, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// Pull the ChatGPT account id out of an id_token. OpenAI nests it under a
// namespaced auth claim; we check the known locations in order and fall back to
// any plausible top-level field.
export function extractAccountId(idToken: string | undefined): string | null {
  if (!idToken) return null;
  const payload = decodeJwtPayload(idToken);
  if (!payload) return null;
  const authClaim = payload['https://api.openai.com/auth'];
  if (authClaim && typeof authClaim === 'object') {
    const a = authClaim as Record<string, unknown>;
    const id = a['chatgpt_account_id'] ?? a['account_id'] ?? a['organization_id'];
    if (typeof id === 'string' && id) return id;
  }
  for (const key of ['chatgpt_account_id', 'account_id', 'organization_id', 'org_id']) {
    const v = payload[key];
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Pasted-redirect parsing (headless fallback)
// ---------------------------------------------------------------------------

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// Accept either the full redirect URL the browser landed on, or just the bare
// code. Returns the code and (when present) the state for cross-checking.
//
// We extract code/state with a scheme-agnostic regex rather than `new URL()`
// because the redirect page fails to load, and Chrome frequently copies the
// address bar WITHOUT the `http://` scheme — e.g.
//   localhost:1455/auth/callback?code=…&state=…
// Feeding that to `new URL()` (or faking a scheme) misparses the query and
// drops the code. The regex handles a full URL, a bare host/path+query, and a
// lone `?code=…&state=…` fragment identically.
export function parsePastedRedirect(input: string): { code: string; state?: string } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const codeMatch = /(?:^|[?&])code=([^&\s#]+)/.exec(trimmed);
  if (codeMatch) {
    const code = safeDecode(codeMatch[1]!);
    const stateMatch = /(?:^|[?&])state=([^&\s#]+)/.exec(trimmed);
    const state = stateMatch ? safeDecode(stateMatch[1]!) : undefined;
    if (code) return state ? { code, state } : { code };
  }

  // Bare code: a single token with no query syntax and no whitespace.
  if (!/\s/.test(trimmed) && !trimmed.includes('=')) return { code: trimmed };
  return null;
}

// ---------------------------------------------------------------------------
// Callback server
// ---------------------------------------------------------------------------

export interface CallbackServer {
  actualPort: Promise<number>;
  code: Promise<string>;
  close: () => void;
}

// Listen for the OAuth redirect and resolve `code` once it arrives. Verifies
// `state` to defend against a stray/forged callback. Mirrors the everyday-
// assistant callback server but on the Codex /auth/callback path.
export function setupCallbackServer(
  bindAddr: string,
  port: number,
  expectedState: string,
  timeoutMs = 5 * 60_000,
): CallbackServer {
  return setupOAuthCallbackServer({
    bindAddr,
    port,
    expectedState,
    timeoutMs,
    callbackPath: CALLBACK_PATH,
    completionMessage:
      'Codex authorization complete. You can close this tab and return to the terminal.',
    noCodeError: 'no code returned by OpenAI',
  });
}
