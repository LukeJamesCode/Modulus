import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import type { Host } from '../../../src/core/modules.js';
import { readTokens, writeTokens, clearTokens, getValidAccessToken, KEYS } from './store.js';

// Minimal Host stub: only `settings` and `log` are touched by the store.
function fakeHost(seed: Record<string, string | number | boolean> = {}): Host {
  const store = new Map<string, string | number | boolean>(Object.entries(seed));
  const noop = (): void => {};
  return {
    settings: {
      get: <T = unknown>(key: string, fallback?: T): T =>
        store.has(key) ? (store.get(key) as unknown as T) : (fallback as T),
      set: (key: string, value: string | number | boolean) => store.set(key, value),
      all: () => Object.fromEntries(store),
    },
    log: {
      info: noop,
      warn: noop,
      error: noop,
      debug: noop,
      child: () => ({ info: noop, warn: noop, error: noop, debug: noop }),
    },
  } as unknown as Host;
}

test('readTokens returns null when not configured', () => {
  assert.equal(readTokens(fakeHost()), null);
});

test('writeTokens then readTokens round-trips', () => {
  const host = fakeHost();
  writeTokens(host, {
    accessToken: 'A',
    refreshToken: 'R',
    idToken: 'I',
    expiresAt: 123,
    accountId: 'acct',
  });
  const t = readTokens(host);
  assert.equal(t?.accessToken, 'A');
  assert.equal(t?.refreshToken, 'R');
  assert.equal(t?.expiresAt, 123);
  assert.equal(t?.accountId, 'acct');
});

test('clearTokens makes the host look unauthed', () => {
  const host = fakeHost({ [KEYS.access]: 'A', [KEYS.refresh]: 'R' });
  assert.notEqual(readTokens(host), null);
  clearTokens(host);
  assert.equal(readTokens(host), null);
});

test('getValidAccessToken returns the stored token when still fresh', async () => {
  const host = fakeHost({
    [KEYS.access]: 'A',
    [KEYS.refresh]: 'R',
    [KEYS.expiresAt]: 10_000_000,
    [KEYS.accountId]: 'acct',
  });
  let fetchCalled = false;
  const fakeFetch = (async () => {
    fetchCalled = true;
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  const v = await getValidAccessToken(host, { fetchImpl: fakeFetch, now: () => 1_000 });
  assert.equal(v.accessToken, 'A');
  assert.equal(fetchCalled, false); // no refresh needed
});

test('getValidAccessToken refreshes an expired token and persists the new one', async () => {
  const host = fakeHost({
    [KEYS.access]: 'OLD',
    [KEYS.refresh]: 'R',
    [KEYS.expiresAt]: 500, // already expired relative to now below
    [KEYS.accountId]: 'acct',
  });
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ access_token: 'NEW', expires_in: 3600 }), {
      status: 200,
    })) as unknown as typeof fetch;

  const v = await getValidAccessToken(host, { fetchImpl: fakeFetch, now: () => 1_000_000 });
  assert.equal(v.accessToken, 'NEW');
  // Persisted back to settings.
  assert.equal(readTokens(host)?.accessToken, 'NEW');
});

test('getValidAccessToken throws when unauthed', async () => {
  await assert.rejects(getValidAccessToken(fakeHost()), /not configured/i);
});
