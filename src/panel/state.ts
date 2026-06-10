// Aggregated dashboard state for GET /api/state.
//
// Ported from the standalone panel's buildState(), adapted for in-process: the
// daemon serving this IS the agent, so "is it running" is always true and the
// pid is our own. Everything else reads live: config, an Ollama probe, the
// module readiness sweep, the metrics snapshot the daemon writes, and a
// couple of cheap counts off the agent_tasks table.

import { cpus, freemem, networkInterfaces, totalmem } from 'node:os';
import type { DB } from '../storage/db.js';
import { effectiveConfig, type ModulusConfig } from '../cli/config-store.js';
import { metricsFilePath } from '../cli/daemon.js';
import { probeOllama } from '../cli/ollama-probe.js';
import { collectModuleReadiness } from '../core/module-readiness.js';
import { readMetrics } from '../core/metrics.js';

const VERSION = '1.0.0';

export interface BuildStateDeps {
  db: DB;
  home: string;
  moduleRoots: readonly string[];
  // The proactive-nudge toggle, owned by the panel runtime (flipped via the
  // settings/agent route). Surfaced here so the dashboard can render it.
  proactive: boolean;
}

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

  return {
    configured: !!cfg && !!cfg.telegram.token && cfg.telegram.allowedIds.length > 0,
    cfgError,
    // The daemon serving this panel is the agent; it is by definition running.
    agent: { running: true, pid: process.pid, starting: false },
    health: {
      ollama: probe.ok,
      ollamaUrl: cfg?.ollama.url ?? null,
      telegram: true,
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
    version: VERSION,
    lan: lanAddress(),
  };
}
