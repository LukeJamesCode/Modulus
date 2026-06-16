// User-created agent schedules. This layer is deliberately small: it stores
// "run this prompt with these agents at this time" rows, and the existing core
// scheduler wakes it once per minute to enqueue normal agent_tasks.

import type { DB } from '../storage/db.js';
import type { Logger } from '../util/log.js';
import type { Scheduler, Nudge } from './scheduler.js';
import type { AgentQueue } from './agent-queue.js';
import type { AgentRegistry, AgentTask } from './agents.js';
import { parseCron, nextFireAfter } from './cron.js';

export type AgentScheduleRecurrence = 'once' | 'daily' | 'weekly' | 'monthly' | 'yearly';

export interface AgentSchedule {
  id: number;
  agentIds: number[];
  prompt: string;
  nextRunAt: number;
  recurrence: AgentScheduleRecurrence;
  // When set, the row recurs on this 5-field cron (matched in `timeZone`) and
  // the sweep advances it via nextFireAfter — `recurrence` is ignored. NULL
  // rows keep the legacy recurrence behaviour.
  cron: string | null;
  timeZone: string | null;
  // A row with no agents but a notify_chat_id is a notify-only reminder: the
  // sweep emits a nudge of `prompt` to this chat. A row WITH agents uses it to
  // ping the chat when the dispatched task finishes.
  notifyChatId: number | null;
  active: boolean;
  lastRunAt: number | null;
  lastTaskIds: number[];
  createdAt: number;
  updatedAt: number;
}

export interface CreateAgentScheduleInput {
  agentIds: number[];
  prompt: string;
  // Optional when `cron` is supplied — the store computes the first fire time.
  nextRunAt?: number;
  recurrence?: AgentScheduleRecurrence;
  cron?: string | null;
  timeZone?: string | null;
  notifyChatId?: number | null;
}

// Per-row dispatch hook: enqueue the prompt for one agent, passing the schedule's
// notify target through so the resulting task pings the chat when it finishes.
export type ScheduleDispatch = (
  agentId: number,
  prompt: string,
  notifyChatId: number | null,
) => AgentTask;

export interface SweepResult {
  // Schedules that fired this sweep (post-advance state).
  fired: AgentSchedule[];
  // Nudges emitted by notify-only reminders, for the scheduler to dispatch
  // through quiet-hours / rate-limit / dedup like any other nudge.
  nudges: Nudge[];
}

export interface AgentScheduleStore {
  create(input: CreateAgentScheduleInput): AgentSchedule;
  get(id: number): AgentSchedule | undefined;
  list(options?: { active?: boolean; limit?: number; chatId?: number }): AgentSchedule[];
  remove(id: number): boolean;
  removeForChat(chatId: number, id: number): boolean;
  sweepDue(dispatch: ScheduleDispatch, at?: Date): SweepResult;
}

interface ScheduleRow {
  id: number;
  agent_ids: string;
  prompt: string;
  next_run_at: number;
  recurrence: string;
  cron: string | null;
  time_zone: string | null;
  notify_chat_id: number | null;
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
    cron: row.cron,
    timeZone: row.time_zone,
    notifyChatId: row.notify_chat_id,
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

export function createAgentScheduleStore(
  db: DB,
  registry: AgentRegistry,
  log?: Logger,
): AgentScheduleStore {
  const insert = db.prepare(
    `INSERT INTO agent_schedules
       (agent_ids, prompt, next_run_at, recurrence, cron, time_zone, notify_chat_id,
        active, created_at, updated_at)
     VALUES (@agent_ids, @prompt, @next_run_at, @recurrence, @cron, @time_zone, @notify_chat_id,
        1, @created_at, @updated_at)`,
  );
  const selectById = db.prepare(`SELECT * FROM agent_schedules WHERE id = ?`);

  function get(id: number): AgentSchedule | undefined {
    const row = selectById.get(id) as ScheduleRow | undefined;
    return row ? rowToSchedule(row) : undefined;
  }

  interface NormalizedSchedule {
    agentIds: number[];
    prompt: string;
    nextRunAt: number;
    recurrence: AgentScheduleRecurrence;
    cron: string | null;
    timeZone: string | null;
    notifyChatId: number | null;
  }

  function validate(input: CreateAgentScheduleInput): NormalizedSchedule {
    const seen = new Set<number>();
    const agentIds = input.agentIds
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0 && !seen.has(id) && seen.add(id));
    for (const id of agentIds) {
      if (!registry.get(id)) throw new Error(`agent ${id} does not exist`);
    }
    const notifyChatId =
      input.notifyChatId != null && Number.isFinite(input.notifyChatId)
        ? Math.trunc(input.notifyChatId)
        : null;
    // A schedule must do *something*: dispatch to an agent, or notify a chat.
    if (agentIds.length === 0 && notifyChatId == null) {
      throw new Error('a schedule needs at least one agent or a notify target');
    }
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error('prompt is required');

    const cron = input.cron?.trim() || null;
    const timeZone = input.timeZone?.trim() || null;
    if (cron) {
      // Validate up front so a bad cron can never reach the sweep. parseCron
      // throws; nextFireAfter proves it can actually fire and gives us the
      // first run time when the caller didn't pass one.
      const parsed = parseCron(cron);
      const firstFire = nextFireAfter(parsed, new Date(), timeZone ?? undefined).getTime();
      const nextRunAt = Number.isFinite(input.nextRunAt) ? Math.trunc(input.nextRunAt!) : firstFire;
      return { agentIds, prompt, nextRunAt, recurrence: 'once', cron, timeZone, notifyChatId };
    }
    if (!Number.isFinite(input.nextRunAt)) throw new Error('nextRunAt must be a timestamp');
    return {
      agentIds,
      prompt,
      nextRunAt: Math.trunc(input.nextRunAt!),
      recurrence: normalizeRecurrence(input.recurrence),
      cron: null,
      timeZone,
      notifyChatId,
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
      cron: normalized.cron,
      time_zone: normalized.timeZone,
      notify_chat_id: normalized.notifyChatId,
      created_at: now,
      updated_at: now,
    });
    return get(Number(info.lastInsertRowid))!;
  }

  function list(options: { active?: boolean; limit?: number; chatId?: number } = {}): AgentSchedule[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options.active !== undefined) {
      clauses.push('active = ?');
      params.push(options.active ? 1 : 0);
    }
    if (options.chatId !== undefined) {
      clauses.push('notify_chat_id = ?');
      params.push(options.chatId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
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

  // Chat-scoped delete so a Telegram /schedule cancel can only remove a reminder
  // that belongs to the same chat — never another chat's schedule by id.
  function removeForChat(chatId: number, id: number): boolean {
    return (
      db
        .prepare(`DELETE FROM agent_schedules WHERE id = ? AND notify_chat_id = ?`)
        .run(id, chatId).changes > 0
    );
  }

  // Compute the post-fire (active, nextRunAt) for a row. Cron rows advance via
  // nextFireAfter and stay active; legacy 'once' rows deactivate; legacy
  // recurring rows step their fixed interval. A cron that somehow fails to
  // advance (corrupt row) is deactivated rather than allowed to throw the sweep.
  function advanceRow(
    schedule: AgentSchedule,
    now: number,
  ): { active: number; nextRunAt: number } {
    if (schedule.cron) {
      try {
        const next = nextFireAfter(
          parseCron(schedule.cron),
          new Date(now),
          schedule.timeZone ?? undefined,
        ).getTime();
        return { active: 1, nextRunAt: next };
      } catch (e) {
        log?.warn('agent-schedules: disabling row with unfireable cron', {
          id: schedule.id,
          cron: schedule.cron,
          error: e instanceof Error ? e.message : String(e),
        });
        return { active: 0, nextRunAt: schedule.nextRunAt };
      }
    }
    if (schedule.recurrence === 'once') return { active: 0, nextRunAt: schedule.nextRunAt };
    return { active: 1, nextRunAt: advanceNextRun(schedule.nextRunAt, schedule.recurrence, now) };
  }

  function sweepDue(dispatch: ScheduleDispatch, at = new Date()): SweepResult {
    const now = at.getTime();
    const due = db
      .prepare(
        `SELECT * FROM agent_schedules
         WHERE active = 1 AND next_run_at <= ?
         ORDER BY next_run_at ASC, id ASC`,
      )
      .all(now) as ScheduleRow[];
    const fired: AgentSchedule[] = [];
    const nudges: Nudge[] = [];
    const update = db.prepare(
      `UPDATE agent_schedules
       SET active = ?, next_run_at = ?, last_run_at = ?, last_task_ids = ?, updated_at = ?
       WHERE id = ?`,
    );

    for (const row of due) {
      const schedule = rowToSchedule(row);
      const taskIds: number[] = [];
      if (schedule.agentIds.length > 0) {
        for (const agentId of schedule.agentIds) {
          if (!registry.get(agentId)) continue;
          taskIds.push(dispatch(agentId, schedule.prompt, schedule.notifyChatId).id);
        }
      } else if (schedule.notifyChatId != null) {
        // Notify-only reminder: hand a nudge to the scheduler, which applies
        // quiet-hours / rate-limit / dedup. The occurrence's next_run_at makes
        // the dedup key unique per fire; defer so a quiet-hours hit retries.
        nudges.push({
          chatId: schedule.notifyChatId,
          text: schedule.prompt,
          key: `schedule:${schedule.id}:${schedule.nextRunAt}`,
          category: 'reminder',
          source: 'agent-schedules',
          defer: true,
          expiresAt: new Date(now + 24 * 60 * 60_000),
        });
      }
      const { active, nextRunAt } = advanceRow(schedule, now);
      update.run(active, nextRunAt, now, JSON.stringify(taskIds), Date.now(), schedule.id);
      fired.push(get(schedule.id)!);
    }
    return { fired, nudges };
  }

  return { create, get, list, remove, removeForChat, sweepDue };
}

export interface AgentSchedulesOptions {
  db: DB;
  scheduler: Scheduler;
  registry: AgentRegistry;
  queue: AgentQueue;
  log: Logger;
}

export function setupAgentSchedules(opts: AgentSchedulesOptions): AgentScheduleStore {
  const log = opts.log.child({ mod: 'agent-schedules' });
  const store = createAgentScheduleStore(opts.db, opts.registry, log);
  opts.scheduler.register({
    module: 'core',
    name: 'agent-schedules-sweep',
    cron: SWEEP_CRON,
    handler: async ({ firedAt }) => {
      const { fired, nudges } = store.sweepDue(
        (agentId, prompt, notifyChatId) => opts.queue.dispatch({ agentId, prompt, notifyChatId }),
        firedAt,
      );
      if (fired.length > 0) log.info('agent schedules fired', { count: fired.length });
      // Notify-only reminders flow back as nudges the scheduler dispatches.
      return nudges;
    },
  });
  return store;
}
