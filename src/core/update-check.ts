// Update-availability check behind the panel's "update available" notification
// and one-click Update button. Two channels:
//
//   git     — a self-hosted / dev / separate-device backend running from a git
//             checkout. Compares the local commit to origin/<branch> via the
//             GitHub API; `modulus update` (git pull + rebuild) then applies it.
//             This is what makes "push to GitHub, press Update" work.
//   desktop — the bundled backend inside the desktop app is a packaged payload,
//             not a checkout, so we compare HOST_VERSION to the latest GitHub
//             *release* (the Velopack channel the shell installs from) and prefer
//             the shell's own downloaded-update status file when it's present.
//
// The result is cached with a TTL so the panel can poll without hammering the
// unauthenticated GitHub API (60 req/h/IP). Every network/exec failure degrades
// to `updateAvailable: null` ("couldn't tell") rather than throwing — an update
// check must never break the panel.

import { execFileSync } from 'node:child_process';
import { HOST_VERSION } from './version.js';

export type UpdateChannel = 'git' | 'desktop' | 'unknown';

export interface UpdateStatus {
  // Short commit (git) or semver (desktop) the backend is currently running.
  current: string;
  channel: UpdateChannel;
  // true = a newer version is published, false = up to date, null = couldn't tell.
  updateAvailable: boolean | null;
  // Latest published commit (git, short) or release tag (desktop), when known.
  latest: string | null;
  // Commits behind origin/<branch> (git channel) when the compare API answers.
  behindBy: number | null;
  // One-line human summary for the panel.
  detail: string;
  checkedAt: number;
}

// The desktop shell writes this (downloaded-update state) for the daemon to read.
export interface DesktopUpdateState {
  hasUpdate: boolean;
  version: string | null;
}

export interface UpdateCheckerOptions {
  // MODULUS_DESKTOP === '1': use the release channel, not git.
  desktop: boolean;
  repoRoot: string;
  // GitHub repo for the desktop release check and the fallback when origin can't
  // be parsed. Matches the desktop shell's Velopack source by default.
  defaultSlug?: string;
  ttlMs?: number;
  fetchImpl?: typeof fetch;
  // Run a git command in repoRoot; trimmed stdout, or null on any error.
  git?: (args: string[]) => string | null;
  // The desktop shell's downloaded-update status (read from its status file).
  readDesktopState?: () => DesktopUpdateState | null;
  now?: () => number;
  timeoutMs?: number;
}

export const DEFAULT_REPO_SLUG = 'LukeJamesCode/Modulus';
const DEFAULT_TTL_MS = 30 * 60_000;
const DEFAULT_TIMEOUT_MS = 5_000;

export interface UpdateChecker {
  // Last cached status (sync), or null before the first check resolves.
  cached(): UpdateStatus | null;
  // Cached status when still fresh, else a refresh. `force` always refreshes.
  check(force?: boolean): Promise<UpdateStatus>;
}

// Parse an `owner/repo` slug from an https or ssh GitHub remote URL.
export function parseGithubSlug(remoteUrl: string): string | null {
  const m = /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(remoteUrl.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

// Compare two dotted numeric versions (leading 'v' and any pre-release suffix
// ignored). Returns >0 when a is newer, <0 when older, 0 when equal.
export function semverCompare(a: string, b: string): number {
  const norm = (s: string): number[] =>
    s
      .replace(/^v/i, '')
      .split('-')[0]!
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0);
  const pa = norm(a);
  const pb = norm(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

export function createUpdateChecker(opts: UpdateCheckerOptions): UpdateChecker {
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const defaultSlug = opts.defaultSlug ?? DEFAULT_REPO_SLUG;
  const git = opts.git ?? defaultGit(opts.repoRoot);

  let cache: UpdateStatus | null = null;
  let inflight: Promise<UpdateStatus> | null = null;

  async function ghJson(path: string): Promise<Record<string, unknown> | null> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`https://api.github.com${path}`, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'modulus-update-check' },
        signal: ctl.signal,
      });
      if (!res.ok) return null;
      return (await res.json()) as Record<string, unknown>;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function checkGit(): Promise<UpdateStatus> {
    const t = now();
    const localFull = git(['rev-parse', 'HEAD']);
    if (!localFull) {
      return {
        current: HOST_VERSION,
        channel: 'unknown',
        updateAvailable: null,
        latest: null,
        behindBy: null,
        detail: 'Not a git checkout — automatic update status is unavailable here.',
        checkedAt: t,
      };
    }
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']) || 'main';
    const slug = parseGithubSlug(git(['remote', 'get-url', 'origin']) || '') ?? defaultSlug;
    const current = localFull.slice(0, 7);

    const remote = await ghJson(`/repos/${slug}/commits/${encodeURIComponent(branch)}`);
    const latestSha = typeof remote?.['sha'] === 'string' ? (remote['sha'] as string) : null;
    if (!latestSha) {
      return {
        current,
        channel: 'git',
        updateAvailable: null,
        latest: null,
        behindBy: null,
        detail: "Couldn't reach GitHub to check for updates.",
        checkedAt: t,
      };
    }
    if (latestSha === localFull) {
      return {
        current,
        channel: 'git',
        updateAvailable: false,
        latest: latestSha.slice(0, 7),
        behindBy: 0,
        detail: "You're on the latest version.",
        checkedAt: t,
      };
    }
    // How far behind: compare base=local head=branch. `ahead_by` counts commits
    // the remote branch has beyond local — i.e. what a pull would bring.
    const cmp = await ghJson(`/repos/${slug}/compare/${localFull}...${encodeURIComponent(branch)}`);
    const status = typeof cmp?.['status'] === 'string' ? (cmp['status'] as string) : null;
    const aheadBy = typeof cmp?.['ahead_by'] === 'number' ? (cmp['ahead_by'] as number) : null;
    // status is the remote branch relative to local: 'ahead'/'diverged' => updates
    // exist; 'behind'/'identical' => we're current or ahead (local unpushed work).
    const available = status ? status === 'ahead' || status === 'diverged' : true;
    return {
      current,
      channel: 'git',
      updateAvailable: available,
      latest: latestSha.slice(0, 7),
      behindBy: aheadBy,
      detail: available
        ? aheadBy
          ? `${aheadBy} new commit${aheadBy === 1 ? '' : 's'} available — press Update to pull and rebuild.`
          : 'A new version is available — press Update to pull and rebuild.'
        : "You're on the latest version.",
      checkedAt: t,
    };
  }

  async function checkDesktop(): Promise<UpdateStatus> {
    const t = now();
    // The shell already downloaded an update: that's the most reliable signal,
    // and it just needs an app restart to apply.
    const ds = opts.readDesktopState?.();
    if (ds?.hasUpdate) {
      return {
        current: HOST_VERSION,
        channel: 'desktop',
        updateAvailable: true,
        latest: ds.version,
        behindBy: null,
        detail: `Update ${ds.version ?? ''}downloaded — restart the app to apply it.`.replace(
          '  ',
          ' ',
        ),
        checkedAt: t,
      };
    }
    const rel = await ghJson(`/repos/${defaultSlug}/releases/latest`);
    const tag = typeof rel?.['tag_name'] === 'string' ? (rel['tag_name'] as string) : null;
    if (!tag) {
      return {
        current: HOST_VERSION,
        channel: 'desktop',
        updateAvailable: ds ? false : null,
        latest: null,
        behindBy: null,
        detail: ds ? "You're on the latest version." : "Couldn't reach GitHub to check for updates.",
        checkedAt: t,
      };
    }
    const available = semverCompare(tag, HOST_VERSION) > 0;
    const clean = tag.replace(/^v/i, '');
    return {
      current: HOST_VERSION,
      channel: 'desktop',
      updateAvailable: available,
      latest: clean,
      behindBy: null,
      detail: available
        ? `Version ${clean} is available — it installs automatically; restart the app to apply.`
        : "You're on the latest version.",
      checkedAt: t,
    };
  }

  async function check(force = false): Promise<UpdateStatus> {
    const t = now();
    if (!force && cache && t - cache.checkedAt < ttlMs) return cache;
    if (inflight) return inflight;
    inflight = (opts.desktop ? checkDesktop() : checkGit())
      .then((s) => {
        cache = s;
        return s;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  return {
    cached: () => cache,
    check,
  };
}

function defaultGit(repoRoot: string): (args: string[]) => string | null {
  return (args) => {
    try {
      return execFileSync('git', args, {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return null;
    }
  };
}
