// User-created agent schedules. This layer is deliberately small: it stores
// "run this prompt with these agents at this time" rows, and the existing core
// scheduler wakes it once per minute to enqueue normal agent_tasks.

import type { DB } from '../storage/db.js';
import type { Logger } from '../util/log.js';
import type { Scheduler } from './scheduler.js';
import type { AgentQueue } from './agent-queue.js';
import type { AgentRegistry, AgentTask } from './agents.js';

export type AgentScheduleRecurrence = 'once' | 'daily' | 'weekly' | 'monthly' | 'yearly';

export interface AgentSchedule {
  id: number;
  agentIds: number[];
  prompt: string;
  nextRunAt: number;
  recurrence: AgentScheduleRecurrence;
  active: boolean;
  lastRunAt: number | null;
  lastTaskIds: number[];
  createdAt: number;
  updatedAt: number;
}

export interface CreateAgentScheduleInput {
  agentIds: number[];
  prompt: string;
  nextRunAt: number;
  recurrence?: AgentScheduleRecurrence;
}

export interface AgentScheduleStore {
  create(input: CreateAgentScheduleInput): AgentSchedule;
  get(id: number): AgentSchedule | undefined;
  list(options?: { active?: boolean; limit?: number }): AgentSchedule[];
  remove(id: number): boolean;
  sweepDue(dispatch: (agentId: number, prompt: string) => AgentTask, at?: Date): AgentSchedule[];
}

interface ScheduleRow {
  id: number;
  agent_ids: string;
  prompt: string;
  next_run_at: number;
  recurrence: string;
  active: number;
  last_run_at: number | null;
  last_task_ids: string | null;
  created_at: number;
  updated_at: number;
}

const SWEEP_CRON = '* * * * *';
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

function parseNumberArray(json: string | null): number[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

function rowToSchedule(row: ScheduleRow): AgentSchedule {
  return {
    id: row.id,
    agentIds: parseNumberArray(row.agent_ids),
    prompt: row.prompt,
    nextRunAt: row.next_run_at,
    recurrence: row.recurrence as AgentScheduleRecurrence,
    active: row.active !== 0,
    lastRunAt: row.last_run_at,
    lastTaskIds: parseNumberArray(row.last_task_ids),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeRecurrence(value: unknown): AgentScheduleRecurrence {
  return value === 'daily' || value === 'weekly' || value === 'monthly' || value === 'yearly'
    ? (value as AgentScheduleRecurrence)
    : 'once';
}

function advanceNextRun(from: number, recurrence: AgentScheduleRecurrence, now: number): number {
  if (recurrence === 'monthly' || recurrence === 'yearly') {
    // Re-anchor on the original day-of-month each step so a schedule set on the
    // 31st doesn't permanently drift after passing through a short month — a
    // naive setMonth(+1) turns Jan 31 into Mar 3. Instead clamp the day to the
    // target month's length (Jan 31 → Feb 28 → Mar 31; leap Feb 29 → next-year
    // Feb 28) while preserving the wall-clock time of day.
    const anchorDay = new Date(from).getDate();
    const monthsPerStep = recurrence === 'monthly' ? 1 : 12;
    const next = new Date(from);
    while (next.getTime() <= now) {
      const monthIndex = next.getFullYear() * 12 + next.getMonth() + monthsPerStep;
      const targetYear = Math.floor(monthIndex / 12);
      const targetMonth = monthIndex % 12;
      // Day 0 of the following month is the last day of the target month.
      const daysInTarget = new Date(targetYear, targetMonth + 1, 0).getDate();
      next.setFullYear(targetYear, targetMonth, Math.min(anchorDay, daysInTarget));
    }
    return next.getTime();
  }
  const step = recurrence === 'weekly' ? WEEK_MS : DAY_MS;
  let next = from + step;
  while (next <= now) next += step;
  return next;
}

export function createAgentScheduleStore(db: DB, registry: AgentRegistry): AgentScheduleStore {
  const insert = db.prepare(
    `INSERT INTO agent_schedules
       (agent_ids, prompt, next_run_at, recurrence, active, created_at, updated_at)
     VALUES (@agent_ids, @prompt, @next_run_at, @recurrence, 1, @created_at, @updated_at)`,
  );
  const selectById = db.prepare(`SELECT * FROM agent_schedules WHERE id = ?`);

  function get(id: number): AgentSchedule | undefined {
    const row = selectById.get(id) as ScheduleRow | undefined;
    return row ? rowToSchedule(row) : undefined;
  }

  function validate(input: CreateAgentScheduleInput): {
    agentIds: number[];
    prompt: string;
    nextRunAt: number;
    recurrence: AgentScheduleRecurrence;
  } {
    const seen = new Set<number>();
    const agentIds = input.agentIds
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0 && !seen.has(id) && seen.add(id));
    if (agentIds.length === 0) throw new Error('at least one agent is required');
    for (const id of agentIds) {
      if (!registry.get(id)) throw new Error(`agent ${id} does not exist`);
    }
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error('prompt is required');
    if (!Number.isFinite(input.nextRunAt)) throw new Error('nextRunAt must be a timestamp');
    return {
      agentIds,
      prompt,
      nextRunAt: Math.trunc(input.nextRunAt),
      recurrence: normalizeRecurrence(input.recurrence),
    };
  }

  function create(input: CreateAgentScheduleInput): AgentSchedule {
    const normalized = validate(input);
    const now = Date.now();
    const info = insert.run({
      agent_ids: JSON.stringify(normalized.agentIds),
      prompt: normalized.prompt,
      next_run_at: normalized.nextRunAt,
      recurrence: normalized.recurrence,
      created_at: now,
      updated_at: now,
    });
    return get(Number(info.lastInsertRowid))!;
  }

  function list(options: { active?: boolean; limit?: number } = {}): AgentSchedule[] {
    const where = options.active === undefined ? '' : 'WHERE active = ?';
    const params: unknown[] = options.active === undefined ? [] : [options.active ? 1 : 0];
    const limit = options.limit ? `LIMIT ${Math.max(1, Math.floor(options.limit))}` : '';
    const rows = db
      .prepare(
        `SELECT * FROM agent_schedules ${where} ORDER BY active DESC, next_run_at ASC, id DESC ${limit}`,
      )
      .all(...params) as ScheduleRow[];
    return rows.map(rowToSchedule);
  }

  function remove(id: number): boolean {
    return db.prepare(`DELETE FROM agent_schedules WHERE id = ?`).run(id).changes > 0;
  }

  function sweepDue(
    dispatch: (agentId: number, prompt: string) => AgentTask,
    at = new Date(),
  ): AgentSchedule[] {
    const now = at.getTime();
    const due = db
      .prepare(
        `SELECT * FROM agent_schedules
         WHERE active = 1 AND next_run_at <= ?
         ORDER BY next_run_at ASC, id ASC`,
      )
      .all(now) as ScheduleRow[];
    const fired: AgentSchedule[] = [];
    const update = db.prepare(
      `UPDATE agent_schedules
       SET active = ?, next_run_at = ?, last_run_at = ?, last_task_ids = ?, updated_at = ?
       WHERE id = ?`,
    );

    for (const row of due) {
      const schedule = rowToSchedule(row);
      const taskIds: number[] = [];
      for (const agentId of schedule.agentIds) {
        if (!registry.get(agentId)) continue;
        taskIds.push(dispatch(agentId, schedule.prompt).id);
      }
      const active = schedule.recurrence === 'once' ? 0 : 1;
      const nextRunAt =
        schedule.recurrence === 'once'
          ? schedule.nextRunAt
          : advanceNextRun(schedule.nextRunAt, schedule.recurrence, now);
      update.run(active, nextRunAt, now, JSON.stringify(taskIds), Date.now(), schedule.id);
      fired.push(get(schedule.id)!);
    }
    return fired;
  }

  return { create, get, list, remove, sweepDue };
}

export interface AgentSchedulesOptions {
  db: DB;
  scheduler: Scheduler;
  registry: AgentRegistry;
  queue: AgentQueue;
  log: Logger;
}

export function setupAgentSchedules(opts: AgentSchedulesOptions): AgentScheduleStore {
  const store = createAgentScheduleStore(opts.db, opts.registry);
  const log = opts.log.child({ mod: 'agent-schedules' });
  opts.scheduler.register({
    extension: 'core',
    name: 'agent-schedules-sweep',
    cron: SWEEP_CRON,
    handler: async ({ firedAt }) => {
      const fired = store.sweepDue(
        (agentId, prompt) => opts.queue.dispatch({ agentId, prompt }),
        firedAt,
      );
      if (fired.length > 0) log.info('agent schedules fired', { count: fired.length });
    },
  });
  return store;
}
