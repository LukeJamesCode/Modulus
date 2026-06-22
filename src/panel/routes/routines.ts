// Routines routes: one unified surface over the two scheduling primitives —
// agent_schedules (fires at a time or on a cron) and standing_orders (the
// heartbeat re-evaluates them). The panel presents both as a single "Routine"
// object (do X · on trigger Y · tell me) so an everyday user never meets the
// words "schedule" or "standing order". The chat tool + Telegram commands keep
// writing the same two stores, so this is a new view, not a second source of
// truth — and both still ride the one scheduler/heartbeat spine.

import {
  createAgentScheduleStore,
  type AgentSchedule,
  type RoutineStep,
  type UpdateAgentScheduleInput,
} from '../../core/agent-schedules.js';
import type { StandingOrder, UpdateStandingOrderInput } from '../../core/standing-orders.js';
import { BUILTIN_MODULUS_NAME } from '../../core/agents.js';
import { parseSchedule, describeSpec, hostTimeZone } from '../../core/schedule-parse.js';
import { readJson, sendJson } from '../http.js';
import type { RouteModule } from '../router.js';
import type { PanelDeps } from '../types.js';
import { ownerChat } from './chat.js';

type AgentNameMap = Map<number, string>;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Human one-liner for a schedule's "when", covering cron, the legacy
// recurrence rows, and one-shots.
function scheduleWhen(s: AgentSchedule, tz: string): string {
  const zone = s.timeZone ?? tz;
  if (s.cron) return describeSpec({ kind: 'recurring', cron: s.cron, timeZone: zone }, zone);
  if (s.recurrence !== 'once') {
    return `${s.recurrence} · next ${new Date(s.nextRunAt).toLocaleString()}`;
  }
  return describeSpec({ kind: 'once', at: s.nextRunAt }, zone);
}

// The edit UI always works in terms of a step list; derive one for legacy rows
// (a single agent + prompt, multiple agents, or a notify-only reminder) so they
// round-trip through the same form.
function scheduleSteps(s: AgentSchedule): RoutineStep[] {
  if (s.steps && s.steps.length > 0) return s.steps;
  if (s.agentIds.length > 0) return s.agentIds.map((id) => ({ agentId: id, instruction: s.prompt }));
  return [{ agentId: null, instruction: s.prompt }];
}

function stepNames(steps: RoutineStep[], names: AgentNameMap): string[] {
  const out = steps
    .filter((st) => st.agentId != null)
    .map((st) => names.get(st.agentId as number) ?? `#${st.agentId}`);
  return out.length > 0 ? out : ['Just messages you'];
}

function scheduleView(s: AgentSchedule, names: AgentNameMap, tz: string, running = false) {
  const steps = scheduleSteps(s);
  return {
    id: s.id,
    kind: 'schedule' as const,
    running,
    trigger: s.cron || s.recurrence !== 'once' ? ('recurring' as const) : ('once' as const),
    agentIds: s.agentIds,
    agentNames: stepNames(steps, names),
    steps,
    stepCount: steps.length,
    prompt: s.prompt,
    cron: s.cron,
    recurrence: s.recurrence,
    nextRunAt: s.nextRunAt,
    timeZone: s.timeZone,
    notify: s.notifyChatId != null,
    active: s.active,
    lastRunAt: s.lastRunAt,
    lastStatus: s.lastStatus,
    lastResult: s.lastResult,
    when: scheduleWhen(s, tz),
  };
}

function watchView(o: StandingOrder, names: AgentNameMap, tz: string) {
  const zone = o.timeZone ?? tz;
  return {
    id: o.id,
    kind: 'watch' as const,
    trigger: 'watch' as const,
    agentIds: o.agentId != null ? [o.agentId] : [],
    agentNames: o.agentId != null ? [names.get(o.agentId) ?? `#${o.agentId}`] : [],
    prompt: o.instruction,
    cron: o.cron,
    timeZone: o.timeZone,
    notifyOnChange: o.notifyOnChange,
    tools: o.tools,
    preapprovedTools: o.preapprovedTools,
    notify: o.notifyChatId != null,
    active: o.active,
    lastRunAt: o.lastFiredAt,
    when: o.cron
      ? describeSpec({ kind: 'recurring', cron: o.cron, timeZone: zone }, zone)
      : 'continuously',
  };
}

// Untrusted JSON body → the fields a time-triggered routine needs. Mirrors the
// old /api/agents/schedules normaliser this route replaces.
function normalizeScheduleBody(body: Record<string, unknown>): {
  agentIds: number[];
  prompt: string;
  nextRunAt: number;
  recurrence: 'once' | 'daily' | 'weekly' | 'monthly' | 'yearly';
  cron: string | null;
  timeZone: string | null;
} {
  const rawIds = Array.isArray(body['agentIds'])
    ? body['agentIds']
    : body['agentId'] !== undefined
      ? [body['agentId']]
      : [];
  const agentIds = rawIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0);
  const recurrence =
    body['recurrence'] === 'daily' ||
    body['recurrence'] === 'weekly' ||
    body['recurrence'] === 'monthly' ||
    body['recurrence'] === 'yearly'
      ? (body['recurrence'] as 'daily' | 'weekly' | 'monthly' | 'yearly')
      : 'once';
  const cron = typeof body['cron'] === 'string' && body['cron'].trim() ? body['cron'].trim() : null;
  const timeZone =
    typeof body['timeZone'] === 'string' && body['timeZone'].trim() ? body['timeZone'].trim() : null;
  return {
    agentIds,
    prompt: String(body['prompt'] ?? '').trim(),
    nextRunAt: Number(body['nextRunAt']),
    recurrence,
    cron,
    timeZone,
  };
}

// A JSON value → a clean string[] of trimmed names (or undefined when empty).
function nameList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
  return out.length > 0 ? out : undefined;
}

// Untrusted JSON body → a sanitized step list (drops steps with no instruction).
// The store collapses a single unconditional step (with no tool grant) back to
// the legacy path; a step carrying tools/preapproved stays in the runner path.
function normalizeSteps(body: Record<string, unknown>): RoutineStep[] {
  const raw = Array.isArray(body['steps']) ? body['steps'] : [];
  const steps: RoutineStep[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const s = item as Record<string, unknown>;
    const instruction = String(s['instruction'] ?? '').trim();
    if (!instruction) continue;
    const rawId = Number(s['agentId']);
    const agentId = Number.isInteger(rawId) && rawId > 0 ? rawId : null;
    const condition =
      typeof s['condition'] === 'string' && s['condition'].trim() ? s['condition'].trim() : undefined;
    const tools = nameList(s['tools']);
    const preapprovedTools = nameList(s['preapprovedTools']);
    const step: RoutineStep = { agentId, instruction };
    if (condition) step.condition = condition;
    if (tools) step.tools = tools;
    if (preapprovedTools) step.preapprovedTools = preapprovedTools;
    steps.push(step);
  }
  return steps;
}

function watchAgentId(body: Record<string, unknown>): number | null {
  const direct = Number(body['agentId']);
  if (Number.isInteger(direct) && direct > 0) return direct;
  if (Array.isArray(body['agentIds']) && body['agentIds'][0] !== undefined) {
    const first = Number(body['agentIds'][0]);
    if (Number.isInteger(first) && first > 0) return first;
  }
  return null;
}

export function createRoutinesRoutes(deps: PanelDeps): RouteModule {
  const reg = deps.agentRegistry;
  const schedules = createAgentScheduleStore(deps.db, reg);
  const tz = (): string => hostTimeZone();
  // The Modulus built-in is hidden from reg.list(), so add it back explicitly —
  // a step run by Modulus must still resolve to a name in the trust line.
  const names = (): AgentNameMap => {
    const map = new Map(reg.list().map((a) => [a.id, a.name]));
    const builtin = reg.getByName(BUILTIN_MODULUS_NAME);
    if (builtin) map.set(builtin.id, builtin.name);
    return map;
  };
  // A schedule is "running" when one of its dispatched tasks is still in flight
  // (single-step / legacy rows record their task ids), or when the runner reports
  // its multi-step run as active. Drives the card's green flash in the panel.
  const isScheduleRunning = (s: AgentSchedule): boolean => {
    if (deps.routineRunner?.isRunning(s.id)) return true;
    return s.lastTaskIds.some((tid) => {
      const t = reg.getTask(tid);
      return !!t && (t.status === 'queued' || t.status === 'running');
    });
  };
  // `notify` is a panel boolean; the chat id stays server-side. Telegram-only
  // by design (see the Routines design) — no owner chat ⇒ no notify target.
  const notifyTarget = (on: unknown): number | null => {
    if (on !== true) return null;
    return ownerChat(deps.db, deps.config)?.chatId ?? null;
  };

  return async ({ req, res, path, method }) => {
    // ---- List ---------------------------------------------------------------
    if (path === '/api/routines' && method === 'GET') {
      const nameMap = names();
      const zone = tz();
      const list = [
        ...schedules
          .list({ limit: 100 })
          .map((s) => scheduleView(s, nameMap, zone, isScheduleRunning(s))),
        ...(deps.standingOrders?.list({ limit: 100 }) ?? []).map((o) => watchView(o, nameMap, zone)),
      ];
      const builtin = reg.getByName(BUILTIN_MODULUS_NAME);
      sendJson(res, 200, {
        routines: list,
        telegram: { available: ownerChat(deps.db, deps.config) != null },
        // Offered as a routine runner alongside the user's agents — Modulus
        // itself handles the step. Omitted on older daemons that don't seed it.
        ...(builtin ? { modulus: { id: builtin.id, name: builtin.name } } : {}),
      });
      return true;
    }

    // The tools a routine step / watch can be restricted to + pre-approve. Drawn
    // from the base registry (minus agent-internal built-ins); 'confirm'-tier
    // entries are the ones the UI offers a pre-approve toggle for.
    if (path === '/api/tools' && method === 'GET') {
      sendJson(res, 200, { tools: deps.toolCatalog?.() ?? [] });
      return true;
    }

    // Preview a plain-English time without creating anything.
    if (path === '/api/routines/parse' && method === 'POST') {
      const body = await readJson<{ text?: string }>(req);
      const spec = await parseSchedule(String(body.text ?? ''), {
        now: new Date(),
        timeZone: hostTimeZone(),
        llm: deps.llm,
        log: deps.log,
      });
      if ('error' in spec) {
        sendJson(res, 200, { error: spec.error });
        return true;
      }
      sendJson(res, 200, {
        spec,
        human: describeSpec(spec, hostTimeZone()),
        ...(spec.kind === 'once' ? { nextRunAt: spec.at } : { cron: spec.cron, timeZone: spec.timeZone }),
      });
      return true;
    }

    // ---- Create -------------------------------------------------------------
    if (path === '/api/routines' && method === 'POST') {
      const body = await readJson<Record<string, unknown>>(req);
      const notifyChatId = notifyTarget(body['notify']);

      if (body['kind'] === 'watch') {
        if (!deps.standingOrders) {
          sendJson(res, 503, { error: 'watch routines unavailable' });
          return true;
        }
        const instruction = String(body['prompt'] ?? body['instruction'] ?? '').trim();
        if (!instruction) {
          sendJson(res, 400, { error: 'a task is required' });
          return true;
        }
        const agentId = watchAgentId(body);
        if (agentId == null) {
          sendJson(res, 400, { error: 'choose an agent to do the checking' });
          return true;
        }
        const cron =
          typeof body['cron'] === 'string' && body['cron'].trim() ? body['cron'].trim() : null;
        try {
          const order = deps.standingOrders.create({
            instruction,
            agentId,
            notifyChatId,
            cron,
            ...(typeof body['timeZone'] === 'string' && body['timeZone'].trim()
              ? { timeZone: body['timeZone'].trim() }
              : {}),
            notifyOnChange: body['notifyOnChange'] === true,
            tools: nameList(body['tools']) ?? null,
            preapprovedTools: nameList(body['preapprovedTools']) ?? null,
          });
          sendJson(res, 200, { routine: watchView(order, names(), tz()) });
        } catch (e) {
          sendJson(res, 400, { error: errMsg(e) });
        }
        return true;
      }

      const input = normalizeScheduleBody(body);
      const steps = normalizeSteps(body);
      const hasSteps = steps.length > 0;
      if (hasSteps) {
        if (!steps.some((st) => st.agentId != null) && notifyChatId == null) {
          sendJson(res, 400, { error: 'add a step with an agent, or turn on Telegram' });
          return true;
        }
      } else if (input.agentIds.length === 0) {
        sendJson(res, 400, { error: 'choose at least one agent' });
        return true;
      } else if (!input.prompt) {
        sendJson(res, 400, { error: 'a task is required' });
        return true;
      }
      if (!input.cron) {
        if (!Number.isFinite(input.nextRunAt)) {
          sendJson(res, 400, { error: 'pick a date and time' });
          return true;
        }
        if (input.nextRunAt <= Date.now()) {
          sendJson(res, 400, { error: 'that time is in the past' });
          return true;
        }
      }
      try {
        const s = schedules.create({
          agentIds: hasSteps ? [] : input.agentIds,
          ...(hasSteps ? { steps } : { prompt: input.prompt }),
          notifyChatId,
          ...(input.cron
            ? { cron: input.cron, timeZone: input.timeZone }
            : { nextRunAt: input.nextRunAt, recurrence: input.recurrence }),
        });
        sendJson(res, 200, { routine: scheduleView(s, names(), tz()) });
      } catch (e) {
        sendJson(res, 400, { error: errMsg(e) });
      }
      return true;
    }

    // ---- Pause / resume -----------------------------------------------------
    const activeMatch = /^\/api\/routines\/(schedule|watch)\/(\d+)\/active$/.exec(path);
    if (activeMatch && method === 'POST') {
      const id = Number(activeMatch[2]);
      const body = await readJson<{ active?: boolean }>(req);
      const active = body.active === true;
      const ok =
        activeMatch[1] === 'watch'
          ? (deps.standingOrders?.setActive(id, active) ?? false)
          : schedules.setActive(id, active);
      sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'not found' });
      return true;
    }

    // ---- Edit / delete ------------------------------------------------------
    const idMatch = /^\/api\/routines\/(schedule|watch)\/(\d+)$/.exec(path);
    if (idMatch) {
      const kind = idMatch[1];
      const id = Number(idMatch[2]);

      if (method === 'DELETE') {
        const ok =
          kind === 'watch'
            ? (deps.standingOrders?.remove(id) ?? false)
            : schedules.remove(id);
        sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'not found' });
        return true;
      }

      if (method === 'PUT') {
        const body = await readJson<Record<string, unknown>>(req);
        // `notify` only overrides when the client sent the key, so a partial
        // edit doesn't silently clear the Telegram target.
        const notifyPatch =
          'notify' in body ? { notifyChatId: notifyTarget(body['notify']) } : {};

        if (kind === 'watch') {
          if (!deps.standingOrders) {
            sendJson(res, 503, { error: 'watch routines unavailable' });
            return true;
          }
          const patch: UpdateStandingOrderInput = { ...notifyPatch };
          if (body['prompt'] !== undefined || body['instruction'] !== undefined) {
            patch.instruction = String(body['prompt'] ?? body['instruction'] ?? '');
          }
          if (body['agentId'] !== undefined || body['agentIds'] !== undefined) {
            patch.agentId = watchAgentId(body);
          }
          if ('cron' in body) {
            patch.cron =
              typeof body['cron'] === 'string' && body['cron'].trim() ? body['cron'].trim() : null;
          }
          if ('timeZone' in body) {
            patch.timeZone =
              typeof body['timeZone'] === 'string' && body['timeZone'].trim()
                ? body['timeZone'].trim()
                : null;
          }
          if (body['notifyOnChange'] !== undefined) patch.notifyOnChange = body['notifyOnChange'] === true;
          if ('tools' in body) patch.tools = nameList(body['tools']) ?? null;
          if ('preapprovedTools' in body) patch.preapprovedTools = nameList(body['preapprovedTools']) ?? null;
          try {
            const order = deps.standingOrders.update(id, patch);
            if (!order) sendJson(res, 404, { error: 'not found' });
            else sendJson(res, 200, { routine: watchView(order, names(), tz()) });
          } catch (e) {
            sendJson(res, 400, { error: errMsg(e) });
          }
          return true;
        }

        const input = normalizeScheduleBody(body);
        const steps = normalizeSteps(body);
        const patch: UpdateAgentScheduleInput = {
          ...(steps.length > 0 ? { steps, agentIds: [] } : { agentIds: input.agentIds, prompt: input.prompt }),
          ...notifyPatch,
          ...(input.cron
            ? { cron: input.cron, timeZone: input.timeZone }
            : { cron: null, nextRunAt: input.nextRunAt, recurrence: input.recurrence }),
        };
        try {
          const s = schedules.update(id, patch);
          if (!s) sendJson(res, 404, { error: 'not found' });
          else sendJson(res, 200, { routine: scheduleView(s, names(), tz()) });
        } catch (e) {
          sendJson(res, 400, { error: errMsg(e) });
        }
        return true;
      }
    }

    return false;
  };
}
