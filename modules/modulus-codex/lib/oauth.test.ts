import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import {
  createPkce,
  buildAuthorizeUrl,
  decodeJwtPayload,
  extractAccountId,
  parsePastedRedirect,
  setupCallbackServer,
  exchangeCode,
  refreshTokens,
  CODEX_CLIENT_ID,
} from './oauth.js';

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

test('PKCE challenge is the S256 of the verifier', () => {
  const { verifier, challenge } = createPkce();
  const expected = b64url(createHash('sha256').update(verifier).digest());
  assert.equal(challenge, expected);
  // verifier must be URL-safe with no padding
  assert.match(verifier, /^[A-Za-z0-9_-]+$/);
});

test('authorize URL carries the scope-trap params', () => {
  const url = new URL(
    buildAuthorizeUrl({
      redirectUri: 'http://localhost:1455/auth/callback',
      challenge: 'CHAL',
      state: 'ST',
    }),
  );
  assert.equal(url.searchParams.get('client_id'), CODEX_CLIENT_ID);
  assert.equal(url.searchParams.get('code_challenge'), 'CHAL');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), 'ST');
  // The two flags that make the token usable against the Codex backend.
  assert.equal(url.searchParams.get('id_token_add_organizations'), 'true');
  assert.equal(url.searchParams.get('codex_cli_simplified_flow'), 'true');
});

test('decodeJwtPayload reads a base64url payload', () => {
  const payload = { sub: 'abc', n: 1 };
  const jwt = `h.${b64url(Buffer.from(JSON.stringify(payload)))}.sig`;
  assert.deepEqual(decodeJwtPayload(jwt), payload);
  assert.equal(decodeJwtPayload('notajwt'), null);
});

test('extractAccountId finds the nested OpenAI auth claim', () => {
  const claim = { 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_123' } };
  const jwt = `h.${b64url(Buffer.from(JSON.stringify(claim)))}.sig`;
  assert.equal(extractAccountId(jwt), 'acct_123');
});

test('extractAccountId falls back to a top-level field', () => {
  const claim = { chatgpt_account_id: 'acct_top' };
  const jwt = `h.${b64url(Buffer.from(JSON.stringify(claim)))}.sig`;
  assert.equal(extractAccountId(jwt), 'acct_top');
  assert.equal(extractAccountId(undefined), null);
});

test('parsePastedRedirect accepts a full URL, a query fragment, and a bare code', () => {
  assert.deepEqual(parsePastedRedirect('http://localhost:1455/auth/callback?code=AAA&state=BBB'), {
    code: 'AAA',
    state: 'BBB',
  });
  assert.deepEqual(parsePastedRedirect('?code=CCC&state=DDD'), { code: 'CCC', state: 'DDD' });
  assert.deepEqual(parsePastedRedirect('justthecode'), { code: 'justthecode' });
  assert.equal(parsePastedRedirect('  '), null);
  assert.equal(parsePastedRedirect('two words'), null);
});

test('parsePastedRedirect handles a scheme-less address bar paste (Chrome)', () => {
  // The exact shape Chrome shows for a failed localhost redirect, no http://.
  const pasted =
    'localhost:1455/auth/callback?code=ac_rlanre3YMCN0zD.AW4Dtnplqg4&scope=openid+profile+email+offline_access&state=5bbd933cf311c0a16bf16dec3512aec2';
  assert.deepEqual(parsePastedRedirect(pasted), {
    code: 'ac_rlanre3YMCN0zD.AW4Dtnplqg4',
    state: '5bbd933cf311c0a16bf16dec3512aec2',
  });
});

test('parsePastedRedirect handles bare "code=…&state=…" with no leading ? or scheme', () => {
  assert.deepEqual(parsePastedRedirect('code=XYZ&state=ST'), { code: 'XYZ', state: 'ST' });
});

test('callback server resolves the code and rejects state mismatch', async () => {
  const server = setupCallbackServer('127.0.0.1', 0, 'good-state');
  const port = await server.actualPort;
  const ok = fetch(`http://127.0.0.1:${port}/auth/callback?code=xyz&state=good-state`);
  const code = await server.code;
  assert.equal(code, 'xyz');
  await ok;

  const server2 = setupCallbackServer('127.0.0.1', 0, 'good-state');
  const port2 = await server2.actualPort;
  const rejected = assert.rejects(server2.code, /state mismatch/i);
  await fetch(`http://127.0.0.1:${port2}/auth/callback?code=xyz&state=WRONG`);
  await rejected;
});

test('exchangeCode posts PKCE fields and computes expiry', async () => {
  let seenBody: URLSearchParams | null = null;
  const fakeFetch = (async (_url: string, init?: RequestInit) => {
    seenBody = new URLSearchParams(String(init?.body));
    return new Response(
      JSON.stringify({ access_token: 'A', refresh_token: 'R', id_token: 'I', expires_in: 3600 }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const tokens = await exchangeCode({
    code: 'C',
    verifier: 'V',
    redirectUri: 'http://localhost:1455/auth/callback',
    fetchImpl: fakeFetch,
    now: () => 1_000,
  });
  assert.equal(tokens.accessToken, 'A');
  assert.equal(tokens.refreshToken, 'R');
  assert.equal(tokens.idToken, 'I');
  assert.equal(tokens.expiresAt, 1_000 + 3600 * 1000);
  assert.equal(seenBody!.get('grant_type'), 'authorization_code');
  assert.equal(seenBody!.get('code_verifier'), 'V');
  assert.equal(seenBody!.get('client_id'), CODEX_CLIENT_ID);
});

test('refreshTokens keeps the old refresh token when the server omits it', async () => {
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ access_token: 'A2', expires_in: 100 }), {
      status: 200,
    })) as unknown as typeof fetch;
  const next = await refreshTokens({
    prev: { accessToken: 'A1', refreshToken: 'R1', idToken: 'I1', expiresAt: 0 },
    fetchImpl: fakeFetch,
    now: () => 5_000,
  });
  assert.equal(next.accessToken, 'A2');
  assert.equal(next.refreshToken, 'R1'); // carried over
  assert.equal(next.idToken, 'I1'); // carried over
  assert.equal(next.expiresAt, 5_000 + 100 * 1000);
});

test('exchangeCode throws a useful error on a non-200', async () => {
  const fakeFetch = (async () => new Response('nope', { status: 400 })) as unknown as typeof fetch;
  await assert.rejects(
    exchangeCode({ code: 'C', verifier: 'V', redirectUri: 'r', fetchImpl: fakeFetch }),
    /token exchange failed \(400\)/i,
  );
});
