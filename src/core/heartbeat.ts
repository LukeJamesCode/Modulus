// The heartbeat: one cheap, registered scheduler job that gives Modulus a pulse
// of its own. Most beats cost a single SQL read — they only escalate (enqueue an
// agent or emit a nudge) when a standing order is actually due. That keeps the
// "one heavy model resident at a time" invariant intact and stays Pi-friendly.
//
// Cadence defaults to every 30 minutes (MODULUS_HEARTBEAT_CRON overrides). It is
// deliberately coarse: minute-exact reminders live in agent_schedules; the
// heartbeat is for conditional watches ("when X changes", "each morning check…").

import { parseCron } from './cron.js';
import type { Scheduler, Nudge } from './scheduler.js';
import type { AgentQueue } from './agent-queue.js';
import type { AgentRegistry } from './agents.js';
import type { StandingOrderStore } from './standing-orders.js';
import type { Logger } from '../util/log.js';

export const DEFAULT_HEARTBEAT_CRON = '*/30 * * * *';

export interface HeartbeatOptions {
  scheduler: Scheduler;
  orders: StandingOrderStore;
  queue: AgentQueue;
  registry: AgentRegistry;
  log: Logger;
  // Cron cadence; falls back to DEFAULT_HEARTBEAT_CRON when unset or invalid.
  cron?: string;
}

export interface HeartbeatStats {
  lastBeatAt: number | null;
  beats: number;
  cron: string;
}

export interface Heartbeat {
  stats(): HeartbeatStats;
  // Run one beat. Public so tests (and a future manual /heartbeat) can drive it
  // without waiting for the tick. Returns the nudges for the scheduler to send.
  beat(at?: Date): Nudge[];
}

// Validate a supplied cron, falling back to the default rather than throwing at
// boot — an operator's typo in MODULUS_HEARTBEAT_CRON shouldn't wedge the daemon.
function resolveCron(cron: string | undefined, log: Logger): string {
  if (!cron) return DEFAULT_HEARTBEAT_CRON;
  try {
    parseCron(cron);
    return cron;
  } catch (e) {
    log.warn('heartbeat: invalid cron, using default', {
      cron,
      default: DEFAULT_HEARTBEAT_CRON,
      error: e instanceof Error ? e.message : String(e),
    });
    return DEFAULT_HEARTBEAT_CRON;
  }
}

export function setupHeartbeat(opts: HeartbeatOptions): Heartbeat {
  const log = opts.log.child({ mod: 'heartbeat' });
  const cron = resolveCron(opts.cron, log);
  let lastBeatAt: number | null = null;
  let beats = 0;

  function beat(at: Date = new Date()): Nudge[] {
    const { fired, nudges, tasksEnqueued } = opts.orders.evaluateDue(
      {
        dispatchAgent: (agentId, instruction, notifyChatId, grant) => {
          if (!opts.registry.get(agentId)) return null;
          return opts.queue.dispatch({
            agentId,
            prompt: instruction,
            notifyChatId,
            toolAllowlistOverride: grant?.tools ?? null,
            preapprovedTools: grant?.preapprovedTools ?? null,
          }).id;
        },
      },
      at,
    );
    lastBeatAt = at.getTime();
    beats += 1;
    if (fired.length > 0) {
      log.info('heartbeat fired standing orders', {
        fired: fired.length,
        tasks: tasksEnqueued,
        nudges: nudges.length,
      });
    }
    return nudges;
  }

  opts.scheduler.register({
    module: 'core',
    name: 'heartbeat',
    cron,
    handler: async ({ firedAt }) => beat(firedAt),
  });

  log.info('heartbeat registered', { cron });
  return {
    stats: () => ({ lastBeatAt, beats, cron }),
    beat,
  };
}
