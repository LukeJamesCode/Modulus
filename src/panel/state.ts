// Aggregated dashboard state for GET /api/state.
//
// Ported from the standalone panel's buildState(), adapted for in-process: the
// daemon serving this IS the agent, so "is it running" is always true and the
// pid is our own. Everything else reads live: config, an Ollama probe, the
// module readiness sweep, the metrics snapshot the daemon writes, and a
// couple of cheap counts off the agent_tasks table.

import { randomUUID } from 'node:crypto';
import { cpus, freemem, networkInterfaces, totalmem } from 'node:os';
import type { DB } from '../storage/db.js';
import { configFileExists, effectiveConfig, type ModulusConfig } from '../cli/config-store.js';
import { metricsFilePath } from '../cli/daemon.js';
import { classifyProbeError, probeOllama } from '../cli/ollama-probe.js';
import { collectModuleReadiness } from '../core/module-readiness.js';
import { loadOrCreatePanelToken } from './auth.js';
import { readMetrics } from '../core/metrics.js';
import { RECOMMENDED_MODELS } from '../cli/profiles.js';
import { HOST_VERSION } from '../core/version.js';

export interface BuildStateDeps {
  db: DB;
  home: string;
  moduleRoots: readonly string[];
  // The proactive-nudge toggle, owned by the panel runtime (flipped via the
  // settings/agent route). Surfaced here so the dashboard can render it.
  proactive: boolean;
  // True when the daemon is serving the panel in setup mode (config incomplete,
  // engine stubbed). The wizard pins itself open on this regardless of the
  // `configured` flag, and a failed promotion surfaces via setupError.
  setupMode?: boolean;
  setupError?: string | null;
}

// Random id minted once per daemon process. The panel polls it in /api/state
// and reloads the page when it changes — so after `modulus update` re-execs a
// fresh daemon (or any restart), the open web/desktop UI auto-refreshes onto
// the freshly-built assets instead of silently running the old ones.
const BOOT_ID = randomUUID();

function lanAddress(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return null;
}

function suggestTier(): { tier: NonNullable<ModulusConfig['tier']>; ramGb: number } {
  const ramGb = totalmem() / 1024 ** 3;
  const tier: NonNullable<ModulusConfig['tier']> =
    ramGb <= 4 ? 'small' : ramGb >= 16 ? 'heavy' : 'standard';
  return { tier, ramGb };
}

// Whole-machine CPU busy %, diffed against the previous reading (cpus() counters
// are cumulative since boot). The panel polls /api/state every few seconds, so
// the delta covers that interval; the first call reports 0 until it has a
// baseline.
let prevCpu: { idle: number; total: number } | null = null;
let lastCpuPercent = 0;
function sampleCpuPercent(): number {
  let idle = 0;
  let total = 0;
  for (const c of cpus()) {
    for (const t of Object.values(c.times)) total += t;
    idle += c.times.idle;
  }
  if (prevCpu) {
    const idleDelta = idle - prevCpu.idle;
    const totalDelta = total - prevCpu.total;
    if (totalDelta > 0) {
      lastCpuPercent = Math.max(0, Math.min(100, Math.round((1 - idleDelta / totalDelta) * 100)));
    }
  }
  prevCpu = { idle, total };
  return lastCpuPercent;
}

export async function buildState(deps: BuildStateDeps): Promise<unknown> {
  const { db, home, moduleRoots } = deps;
  let cfg: ModulusConfig | null = null;
  let cfgError: string | null = null;
  try {
    cfg = effectiveConfig(home);
  } catch (e) {
    cfgError = e instanceof Error ? e.message : String(e);
  }

  const probe = cfg ? await probeOllama(cfg.ollama.url) : { ok: false, models: [] };
  const readiness = collectModuleReadiness(moduleRoots, db);
  const enabledList = readiness.filter((e) => e.enabled);
  const enabledNames = enabledList.map((e) => e.name);
  const needsSetup = enabledList
    .filter((e) => e.status === 'needs_auth' || e.status === 'needs_settings')
    .map((e) => ({ name: e.name, status: e.status, nextAction: e.nextAction }));
  const metrics = readMetrics(metricsFilePath(home));
  const { tier: suggestedTier, ramGb } = suggestTier();

  // Live agent-engine load, straight off the task table the queue drains.
  const taskStats = (() => {
    const queued = (
      db
        .prepare(`SELECT COUNT(*) AS n FROM agent_tasks WHERE status IN ('queued', 'running')`)
        .get() as { n: number }
    ).n;
    const errors = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM agent_tasks WHERE status = 'error' AND finished_at >= ?`,
        )
        .get(Date.now() - 24 * 60 * 60 * 1000) as { n: number }
    ).n;
    return { queueDepth: queued, errors24h: errors };
  })();

  const sched = metrics?.scheduler;
  const activity = metrics
    ? {
        startedAt: metrics.startedAt,
        metricsAt: metrics.updatedAt,
        uptimeMs: metrics.uptimeMs,
        lastTickAt: sched?.lastTickAt ?? null,
        ticks: sched?.ticks ?? 0,
        nudgesSent: sched?.nudgesSent ?? 0,
        nudgesDropped: sched ? Object.values(sched.nudgesDropped).reduce((a, b) => a + b, 0) : 0,
        cacheHits: sched?.cache?.hits ?? 0,
        cacheMisses: sched?.cache?.misses ?? 0,
      }
    : null;

  // Configured = the user finished setup. Telegram is optional: a panel-only
  // install (config.json written, no bot token) is configured, and an env-only
  // Telegram deployment (token + allowlist, no file) counts too. The one case we
  // still bounce back to the wizard is a HALF-set Telegram — a token with no one
  // allowlisted — because that's a misconfiguration, not a panel-only choice.
  const hasToken = !!cfg && !!cfg.telegram.token;
  const hasAllowlist = !!cfg && cfg.telegram.allowedIds.length > 0;
  const telegramHalfSet = hasToken && !hasAllowlist;
  const configured =
    !!cfg && !telegramHalfSet && (configFileExists(home) || (hasToken && hasAllowlist));

  return {
    configured,
    cfgError,
    // The daemon serving this panel is the agent; it is by definition running.
    agent: { running: true, pid: process.pid, starting: false },
    health: {
      ollama: probe.ok,
      ollamaUrl: cfg?.ollama.url ?? null,
      ollamaError: probe.error ?? null,
      ollamaErrorKind: classifyProbeError(probe.error),
      // Whether a Telegram bot is configured at all (false on a panel-only
      // install). Not a liveness probe — the long-poll has no cheap health ping.
      telegram: hasToken && hasAllowlist,
      modelCount: probe.models.length,
    },
    models: {
      chat: cfg?.models.chat ?? null,
      reason: cfg?.models.reason ?? null,
      tools: cfg?.models.tools ?? null,
      loaded: [cfg?.models.chat, cfg?.models.tools].filter(Boolean).length,
    },
    allowlistCount: cfg?.telegram.allowedIds.length ?? 0,
    tier: cfg?.tier ?? suggestedTier,
    suggestedTier,
    ramGb: Math.round(ramGb * 10) / 10,
    freeRamGb: Math.round((freemem() / 1024 ** 3) * 10) / 10,
    logLevel: cfg?.logLevel ?? 'info',
    modules: {
      installed: readiness.length,
      enabled: enabledList.length,
      enabledNames,
      needsSetup,
    },
    proactive: deps.proactive,
    queueDepth: taskStats.queueDepth,
    system: {
      cpuPercent: sampleCpuPercent(),
      ramPercent: Math.max(0, Math.min(100, Math.round((1 - freemem() / totalmem()) * 100))),
      queueDepth: taskStats.queueDepth,
      errors24h: taskStats.errors24h,
    },
    scheduler: metrics
      ? { jobs: metrics.scheduler.jobsRegistered, nudgesSent: metrics.scheduler.nudgesSent }
      : null,
    activity,
    version: HOST_VERSION,
    bootId: BOOT_ID,
    lan: lanAddress(),
    // When the panel is LAN-bound (the "host for other devices" topology), hand
    // the UI the exact tokenized link to paste into the desktop app or another
    // browser. Loopback-bound installs report lan:false and no url. The token is
    // already gating this very response, so surfacing it here leaks nothing new.
    connect: (() => {
      const bind = cfg?.panel?.bind ?? '127.0.0.1';
      const ip = lanAddress();
      if (bind !== '0.0.0.0' || !ip) return { lan: false, url: null as string | null };
      const port = cfg?.panel?.port ?? 7777;
      return { lan: true, url: `http://${ip}:${port}/?token=${loadOrCreatePanelToken(home)}` };
    })(),
    // Running under the desktop shell: updates come from the shell's own
    // updater, not the git checkout, so the panel hides `modulus update`.
    desktop: process.env.MODULUS_DESKTOP === '1',
    // Setup-mode flags + the per-tier model recommendations the wizard renders.
    // modelRecommendations is sent for every tier so flipping the tier control
    // re-renders the recommendation card without a round-trip.
    setupMode: !!deps.setupMode,
    setupError: deps.setupError ?? null,
    modelRecommendations: RECOMMENDED_MODELS,
  };
}
