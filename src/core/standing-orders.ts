// Standing orders: conditional agency the heartbeat evaluates. Where an
// agent_schedules row fires at a fixed time, a standing order is *evaluated*
// each beat and acts only when it should — enqueue an agent to check something
// and report, or nudge the user (optionally only when an observed state
// changes). The store is pure; the heartbeat owns the clock and the wiring.

import type { DB } from '../storage/db.js';
import type { Logger } from '../util/log.js';
import type { Nudge } from './scheduler.js';
import { parseCron, nextFireAfter } from './cron.js';

export interface StandingOrder {
  id: number;
  instruction: string;
  // NULL = notify-only; set = run this agent and report back.
  agentId: number | null;
  notifyChatId: number | null;
  // Coarse timing matched in `timeZone`; NULL = cadence-gated only.
  cron: string | null;
  timeZone: string | null;
  // Minimum ms between evaluations when there's no cron. 0/NULL = every beat.
  cadenceMs: number | null;
  // Notify-only: fire only when the probed state differs from lastState.
  notifyOnChange: boolean;
  active: boolean;
  lastEvaluatedAt: number | null;
  lastFiredAt: number | null;
  lastState: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateStandingOrderInput {
  instruction: string;
  agentId?: number | null;
  notifyChatId?: number | null;
  cron?: string | null;
  timeZone?: string | null;
  cadenceMs?: number | null;
  notifyOnChange?: boolean;
}

// Per-evaluation wiring the heartbeat supplies.
export interface StandingOrderHandlers {
  // Enqueue an agent task for an agentic order; return its task id, or null if
  // the agent no longer exists (the order simply doesn't fire this beat).
  dispatchAgent: (
    agentId: number,
    instruction: string,
    notifyChatId: number | null,
  ) => number | null;
  // Optional state probe for notify_on_change orders. Returns the current
  // observed state; the order fires only when it differs from lastState.
  probe?: (order: StandingOrder) => string | null | undefined;
}

export interface EvaluateResult {
  fired: StandingOrder[];
  nudges: Nudge[];
  tasksEnqueued: number;
}

// An edit. Every field is optional; an omitted field keeps its current value.
export type UpdateStandingOrderInput = Partial<CreateStandingOrderInput>;

export interface StandingOrderStore {
  create(input: CreateStandingOrderInput): StandingOrder;
  get(id: number): StandingOrder | undefined;
  list(options?: { active?: boolean; chatId?: number; limit?: number }): StandingOrder[];
  update(id: number, patch: UpdateStandingOrderInput): StandingOrder | undefined;
  remove(id: number): boolean;
  removeForChat(chatId: number, id: number): boolean;
  setActive(id: number, active: boolean): boolean;
  evaluateDue(handlers: StandingOrderHandlers, at?: Date): EvaluateResult;
}

interface OrderRow {
  id: number;
  instruction: string;
  agent_id: number | null;
  notify_chat_id: number | null;
  cron: string | null;
  time_zone: string | null;
  cadence_ms: number | null;
  notify_on_change: number;
  active: number;
  last_evaluated_at: number | null;
  last_fired_at: number | null;
  last_state: string | null;
  created_at: number;
  updated_at: number;
}

function rowToOrder(row: OrderRow): StandingOrder {
  return {
    id: row.id,
    instruction: row.instruction,
    agentId: row.agent_id,
    notifyChatId: row.notify_chat_id,
    cron: row.cron,
    timeZone: row.time_zone,
    cadenceMs: row.cadence_ms,
    notifyOnChange: row.notify_on_change !== 0,
    active: row.active !== 0,
    lastEvaluatedAt: row.last_evaluated_at,
    lastFiredAt: row.last_fired_at,
    lastState: row.last_state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createStandingOrderStore(db: DB, log?: Logger): StandingOrderStore {
  const insert = db.prepare(
    `INSERT INTO standing_orders
       (instruction, agent_id, notify_chat_id, cron, time_zone, cadence_ms,
        notify_on_change, active, created_at, updated_at)
     VALUES (@instruction, @agent_id, @notify_chat_id, @cron, @time_zone, @cadence_ms,
        @notify_on_change, 1, @created_at, @updated_at)`,
  );
  const selectById = db.prepare(`SELECT * FROM standing_orders WHERE id = ?`);

  function get(id: number): StandingOrder | undefined {
    const row = selectById.get(id) as OrderRow | undefined;
    return row ? rowToOrder(row) : undefined;
  }

  function create(input: CreateStandingOrderInput): StandingOrder {
    const instruction = input.instruction.trim();
    if (!instruction) throw new Error('instruction is required');
    const agentId = input.agentId != null && Number.isInteger(input.agentId) ? input.agentId : null;
    const notifyChatId =
      input.notifyChatId != null && Number.isFinite(input.notifyChatId)
        ? Math.trunc(input.notifyChatId)
        : null;
    if (agentId == null && notifyChatId == null) {
      throw new Error('a standing order needs an agent to run or a chat to notify');
    }
    const cron = input.cron?.trim() || null;
    if (cron) parseCron(cron); // validate up front; throws on a bad expression
    const timeZone = input.timeZone?.trim() || null;
    const cadenceMs =
      input.cadenceMs != null && Number.isFinite(input.cadenceMs) && input.cadenceMs >= 0
        ? Math.trunc(input.cadenceMs)
        : null;
    const now = Date.now();
    const info = insert.run({
      instruction,
      agent_id: agentId,
      notify_chat_id: notifyChatId,
      cron,
      time_zone: timeZone,
      cadence_ms: cadenceMs,
      notify_on_change: input.notifyOnChange ? 1 : 0,
      created_at: now,
      updated_at: now,
    });
    return get(Number(info.lastInsertRowid))!;
  }

  function list(
    options: { active?: boolean; chatId?: number; limit?: number } = {},
  ): StandingOrder[] {
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
      .prepare(`SELECT * FROM standing_orders ${where} ORDER BY active DESC, id DESC ${limit}`)
      .all(...params) as OrderRow[];
    return rows.map(rowToOrder);
  }

  function remove(id: number): boolean {
    return db.prepare(`DELETE FROM standing_orders WHERE id = ?`).run(id).changes > 0;
  }

  function removeForChat(chatId: number, id: number): boolean {
    return (
      db.prepare(`DELETE FROM standing_orders WHERE id = ? AND notify_chat_id = ?`).run(id, chatId)
        .changes > 0
    );
  }

  function setActive(id: number, active: boolean): boolean {
    return (
      db
        .prepare(`UPDATE standing_orders SET active = ?, updated_at = ? WHERE id = ?`)
        .run(active ? 1 : 0, Date.now(), id).changes > 0
    );
  }

  // Edit an existing order. Untouched fields keep their value; the same checks
  // create() applies (must do something, valid cron) gate the write.
  function update(id: number, patch: UpdateStandingOrderInput): StandingOrder | undefined {
    const existing = get(id);
    if (!existing) return undefined;
    const instruction =
      patch.instruction !== undefined ? patch.instruction.trim() : existing.instruction;
    if (!instruction) throw new Error('instruction is required');
    const agentId =
      patch.agentId !== undefined
        ? patch.agentId != null && Number.isInteger(patch.agentId)
          ? patch.agentId
          : null
        : existing.agentId;
    const notifyChatId =
      patch.notifyChatId !== undefined
        ? patch.notifyChatId != null && Number.isFinite(patch.notifyChatId)
          ? Math.trunc(patch.notifyChatId)
          : null
        : existing.notifyChatId;
    if (agentId == null && notifyChatId == null) {
      throw new Error('a standing order needs an agent to run or a chat to notify');
    }
    const cron = patch.cron !== undefined ? patch.cron?.trim() || null : existing.cron;
    if (cron) parseCron(cron); // validate up front; throws on a bad expression
    const timeZone = patch.timeZone !== undefined ? patch.timeZone?.trim() || null : existing.timeZone;
    const cadenceMs =
      patch.cadenceMs !== undefined
        ? patch.cadenceMs != null && Number.isFinite(patch.cadenceMs) && patch.cadenceMs >= 0
          ? Math.trunc(patch.cadenceMs)
          : null
        : existing.cadenceMs;
    const notifyOnChange =
      patch.notifyOnChange !== undefined ? !!patch.notifyOnChange : existing.notifyOnChange;
    db.prepare(
      `UPDATE standing_orders
       SET instruction = ?, agent_id = ?, notify_chat_id = ?, cron = ?, time_zone = ?,
           cadence_ms = ?, notify_on_change = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      instruction,
      agentId,
      notifyChatId,
      cron,
      timeZone,
      cadenceMs,
      notifyOnChange ? 1 : 0,
      Date.now(),
      id,
    );
    return get(id);
  }

  function isDue(order: StandingOrder, at: Date): boolean {
    if (order.cron) {
      try {
        // Catch-up, not exact-minute match: the heartbeat is coarse (default
        // every 30 min), so a cron whose minute never lands on a beat — e.g.
        // "15 9 * * *" against :00/:30 beats — would never fire on an exact
        // match. Fire on the first beat at/after the scheduled time instead, by
        // asking whether a cron occurrence has elapsed since we last evaluated
        // this order (its creation time on the first beat). Mirrors how
        // agent-schedules advances on next_run_at <= now.
        const anchor = order.lastEvaluatedAt ?? order.createdAt;
        const next = nextFireAfter(
          parseCron(order.cron),
          new Date(anchor),
          order.timeZone ?? undefined,
        );
        return next.getTime() <= at.getTime();
      } catch (e) {
        log?.warn('standing-orders: disabling order with bad cron', {
          id: order.id,
          cron: order.cron,
          error: e instanceof Error ? e.message : String(e),
        });
        setActive(order.id, false);
        return false;
      }
    }
    const cadence = order.cadenceMs ?? 0;
    return order.lastEvaluatedAt == null || at.getTime() - order.lastEvaluatedAt >= cadence;
  }

  const recordEval = db.prepare(
    `UPDATE standing_orders
     SET last_evaluated_at = ?, last_fired_at = ?, last_state = ?, updated_at = ?
     WHERE id = ?`,
  );

  function evaluateDue(handlers: StandingOrderHandlers, at = new Date()): EvaluateResult {
    const now = at.getTime();
    const active = db
      .prepare(`SELECT * FROM standing_orders WHERE active = 1 ORDER BY id ASC`)
      .all() as OrderRow[];
    const fired: StandingOrder[] = [];
    const nudges: Nudge[] = [];
    let tasksEnqueued = 0;

    for (const row of active) {
      const order = rowToOrder(row);
      if (!isDue(order, at)) continue;

      let didFire = false;
      let nextState = order.lastState;

      if (order.agentId != null) {
        const taskId = handlers.dispatchAgent(order.agentId, order.instruction, order.notifyChatId);
        if (taskId != null) {
          didFire = true;
          tasksEnqueued += 1;
        }
      } else if (order.notifyChatId != null) {
        let changed = true;
        if (order.notifyOnChange) {
          if (handlers.probe) {
            const probed = handlers.probe(order) ?? null;
            nextState = probed;
            changed = probed !== order.lastState;
          } else {
            // Change-gated, but nothing observes the state this beat: with no
            // probe wired there is no detectable change, so stay silent rather
            // than nudge on every due beat (the toggle would otherwise be a
            // per-beat spammer). A probe is supplied by whatever watches the
            // external state being tracked.
            changed = false;
          }
        }
        if (changed) {
          nudges.push({
            chatId: order.notifyChatId,
            text: order.instruction,
            key: `standing:${order.id}:${now}`,
            category: 'standing-order',
            source: 'heartbeat',
            defer: true,
            expiresAt: new Date(now + 6 * 60 * 60_000),
          });
          didFire = true;
        }
      }

      recordEval.run(now, didFire ? now : order.lastFiredAt, nextState, now, order.id);
      if (didFire) fired.push(get(order.id)!);
    }
    return { fired, nudges, tasksEnqueued };
  }

  return { create, get, list, update, remove, removeForChat, setActive, evaluateDue };
}
