import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  createUpdateChecker,
  parseGithubSlug,
  semverCompare,
  type DesktopUpdateState,
} from './update-check.js';
import { HOST_VERSION } from './version.js';

test('parseGithubSlug handles https and ssh remotes', () => {
  assert.equal(parseGithubSlug('https://github.com/LukeJamesCode/Modulus.git'), 'LukeJamesCode/Modulus');
  assert.equal(parseGithubSlug('https://github.com/owner/repo'), 'owner/repo');
  assert.equal(parseGithubSlug('git@github.com:owner/repo.git'), 'owner/repo');
  assert.equal(parseGithubSlug('https://gitlab.com/owner/repo.git'), null);
});

test('semverCompare orders versions, tolerating v-prefix and pre-release', () => {
  assert.ok(semverCompare('1.6.0', '1.5.0') > 0);
  assert.ok(semverCompare('v1.5.0', '1.5.0') === 0);
  assert.ok(semverCompare('1.5.0', '1.5.1') < 0);
  assert.ok(semverCompare('2.0.0-beta', '1.9.9') > 0);
});

// Minimal fake fetch keyed by URL substring.
function fakeFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (url: string) => {
    for (const [needle, body] of Object.entries(routes)) {
      if (url.includes(needle)) {
        return { ok: true, json: async () => body } as Response;
      }
    }
    return { ok: false, json: async () => ({}) } as Response;
  }) as unknown as typeof fetch;
}

const gitStub =
  (head: string, branch = 'main', origin = 'https://github.com/LukeJamesCode/Modulus.git') =>
  (args: string[]): string | null => {
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return head;
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return branch;
    if (args[0] === 'remote') return origin;
    return null;
  };

test('git channel: up to date when local HEAD equals origin', async () => {
  const head = 'a'.repeat(40);
  const checker = createUpdateChecker({
    desktop: false,
    repoRoot: '/x',
    git: gitStub(head),
    fetchImpl: fakeFetch({ '/commits/main': { sha: head } }),
  });
  const s = await checker.check();
  assert.equal(s.channel, 'git');
  assert.equal(s.updateAvailable, false);
  assert.equal(s.behindBy, 0);
});

test('git channel: behind when origin is ahead, with commit count', async () => {
  const head = 'a'.repeat(40);
  const remote = 'b'.repeat(40);
  const checker = createUpdateChecker({
    desktop: false,
    repoRoot: '/x',
    git: gitStub(head),
    fetchImpl: fakeFetch({
      '/commits/main': { sha: remote },
      '/compare/': { status: 'ahead', ahead_by: 3 },
    }),
  });
  const s = await checker.check();
  assert.equal(s.updateAvailable, true);
  assert.equal(s.behindBy, 3);
  assert.equal(s.latest, remote.slice(0, 7));
});

test('git channel: GitHub unreachable degrades to null, not an error', async () => {
  const checker = createUpdateChecker({
    desktop: false,
    repoRoot: '/x',
    git: gitStub('a'.repeat(40)),
    fetchImpl: fakeFetch({}), // every route 404s
  });
  const s = await checker.check();
  assert.equal(s.updateAvailable, null);
});

test('git channel: not a checkout -> unknown channel, null availability', async () => {
  const checker = createUpdateChecker({
    desktop: false,
    repoRoot: '/x',
    git: () => null,
    fetchImpl: fakeFetch({}),
  });
  const s = await checker.check();
  assert.equal(s.channel, 'unknown');
  assert.equal(s.updateAvailable, null);
});

test('desktop channel: a newer release tag means update available', async () => {
  const checker = createUpdateChecker({
    desktop: true,
    repoRoot: '/x',
    fetchImpl: fakeFetch({ '/releases/latest': { tag_name: 'v99.0.0' } }),
  });
  const s = await checker.check();
  assert.equal(s.channel, 'desktop');
  assert.equal(s.updateAvailable, true);
  assert.equal(s.latest, '99.0.0');
});

test('desktop channel: shell status file short-circuits to update-ready', async () => {
  const ds: DesktopUpdateState = { hasUpdate: true, version: '2.0.0' };
  const checker = createUpdateChecker({
    desktop: true,
    repoRoot: '/x',
    readDesktopState: () => ds,
    // Releases route omitted — the status file must win without a network call.
    fetchImpl: fakeFetch({}),
  });
  const s = await checker.check();
  assert.equal(s.updateAvailable, true);
  assert.equal(s.latest, '2.0.0');
});

test('desktop channel: current release matches HOST_VERSION -> up to date', async () => {
  const checker = createUpdateChecker({
    desktop: true,
    repoRoot: '/x',
    fetchImpl: fakeFetch({ '/releases/latest': { tag_name: `v${HOST_VERSION}` } }),
  });
  const s = await checker.check();
  assert.equal(s.updateAvailable, false);
});

test('check() caches within the TTL and refreshes on force', async () => {
  let calls = 0;
  const head = 'a'.repeat(40);
  const fetchImpl = (async (url: string) => {
    if (url.includes('/commits/main')) {
      calls++;
      return { ok: true, json: async () => ({ sha: head }) } as Response;
    }
    return { ok: false, json: async () => ({}) } as Response;
  }) as unknown as typeof fetch;
  let clock = 1000;
  const checker = createUpdateChecker({
    desktop: false,
    repoRoot: '/x',
    git: gitStub(head),
    fetchImpl,
    now: () => clock,
    ttlMs: 10_000,
  });
  await checker.check();
  await checker.check(); // within TTL -> cached
  assert.equal(calls, 1);
  clock += 20_000; // past TTL
  await checker.check();
  assert.equal(calls, 2);
  assert.ok(checker.cached());
});
