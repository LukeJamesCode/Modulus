import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import type { FetchLike } from './installer.js';
import {
  fetchRegistryIndex,
  findRegistryEntry,
  registryUrl,
  DEFAULT_REGISTRY_URL,
} from './registry.js';

// A fetch stub serving fixed bodies per URL (mirrors installer.test.ts).
function fakeFetch(bodies: Record<string, string>): FetchLike {
  return async (url) => {
    const body = bodies[url];
    return {
      ok: body !== undefined,
      status: body !== undefined ? 200 : 404,
      headers: { get: () => null },
      arrayBuffer: async () => {
        const buf = Buffer.from(body ?? '', 'utf8');
        const ab = new ArrayBuffer(buf.byteLength);
        new Uint8Array(ab).set(buf);
        return ab;
      },
    };
  };
}

const URL_ = 'https://example.test/index.json';
const VALID_ENTRY = {
  name: 'modulus-todo',
  version: '1.2.0',
  tarball: 'https://example.test/modulus-todo-1.2.0.tgz',
  sha256: 'a'.repeat(64),
  permissions: { network: ['example.test'] },
};

test('fetches and parses both the array and {modules:[...]} index shapes', async () => {
  const asArray = await fetchRegistryIndex({
    url: URL_,
    fetchImpl: fakeFetch({ [URL_]: JSON.stringify([VALID_ENTRY]) }),
  });
  assert.equal(asArray.length, 1);
  assert.equal(asArray[0]!.name, 'modulus-todo');
  assert.equal(asArray[0]!.tarball, VALID_ENTRY.tarball);

  const asObject = await fetchRegistryIndex({
    url: URL_,
    fetchImpl: fakeFetch({ [URL_]: JSON.stringify({ modules: [VALID_ENTRY] }) }),
  });
  assert.equal(asObject.length, 1);
});

test('a transport error surfaces as InstallError, not a silent empty list', async () => {
  // A 404 must throw — an empty marketplace and an unreachable registry are very
  // different states and the UI needs to tell them apart.
  await assert.rejects(fetchRegistryIndex({ url: URL_, fetchImpl: fakeFetch({}) }), /HTTP 404/);
});

test('invalid JSON throws rather than returning garbage', async () => {
  await assert.rejects(
    fetchRegistryIndex({ url: URL_, fetchImpl: fakeFetch({ [URL_]: 'not json{' }) }),
    /not valid JSON/,
  );
});

test('a malformed entry is loud (curated index: a bad entry is a publishing bug)', async () => {
  const bad = { ...VALID_ENTRY, tarball: 'http://insecure.test/x.tgz' }; // not https
  await assert.rejects(
    fetchRegistryIndex({ url: URL_, fetchImpl: fakeFetch({ [URL_]: JSON.stringify([bad]) }) }),
    /https/,
  );
});

test('an oversized index body is rejected', async () => {
  const huge = JSON.stringify([VALID_ENTRY]) + ' '.repeat(2000);
  await assert.rejects(
    fetchRegistryIndex({ url: URL_, maxBytes: 100, fetchImpl: fakeFetch({ [URL_]: huge }) }),
    /size cap/,
  );
});

test('findRegistryEntry resolves by exact name, null otherwise', async () => {
  const entries = await fetchRegistryIndex({
    url: URL_,
    fetchImpl: fakeFetch({ [URL_]: JSON.stringify([VALID_ENTRY]) }),
  });
  assert.equal(findRegistryEntry(entries, 'modulus-todo')?.version, '1.2.0');
  assert.equal(findRegistryEntry(entries, 'nope'), null);
});

test('MODULUS_REGISTRY_URL overrides the default index URL', () => {
  const prev = process.env['MODULUS_REGISTRY_URL'];
  try {
    delete process.env['MODULUS_REGISTRY_URL'];
    assert.equal(registryUrl(), DEFAULT_REGISTRY_URL);
    process.env['MODULUS_REGISTRY_URL'] = 'https://fork.test/index.json';
    assert.equal(registryUrl(), 'https://fork.test/index.json');
  } finally {
    if (prev === undefined) delete process.env['MODULUS_REGISTRY_URL'];
    else process.env['MODULUS_REGISTRY_URL'] = prev;
  }
});
