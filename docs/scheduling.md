# Scheduling, reminders, heartbeat & standing orders — design

Status: **implemented** (1.3.0). This documents the settled design; the code is
the source of truth. Everything here rides primitives that already existed (the
cron engine, the per-minute scheduler tick, the nudge dispatch pipeline) rather
than adding a parallel scheduler.

## The one spine

Three user-facing features share a single spine so there is one place that
understands "when":

- **Cron + IANA time zone** ([cron.ts](../src/core/cron.ts)) — `parseCron`,
  `matchesCron`, `nextFireAfter`, all tz-aware. Reused as the schedule spine.
- **The scheduler tick** ([scheduler.ts](../src/core/scheduler.ts)) — one
  internal tick per minute; jobs return `Nudge[]` that the dispatcher routes
  through quiet-hours / cross-module rate-limit / restart-safe dedup / deferral.

Nothing new replaces either. The features are layers on top.

## Natural-language parsing

[schedule-parse.ts](../src/core/schedule-parse.ts) — `parseSchedule(text, { now,
timeZone, llm? })` → `{ kind:'once', at }` | `{ kind:'recurring', cron, timeZone }`
| `{ error }`. Pure and explicit-tz so it unit-tests with a fixed clock + FakeLLM.

Two tiers, mirroring [agent-router.ts](../src/core/agent-router.ts):

1. **Rules pass** (no model) covers the common 90% — "in 20 minutes",
   "every weekday at 8am", "every 2 hours", "tomorrow at 5pm", "monthly on the
   1st", bare "5pm". Wall-clock phrases resolve against the caller's zone via a
   one-correction offset computation (DST-safe within a refinement pass).
2. **Tiny-model fallback** for novel phrasings emits `{"once":…}` / `{"cron":…}`
   JSON, then it is **validated back through `cron.ts` / date math** — a
   hallucinated cron or a past time can never persist.

The caller resolves the zone (`hostTimeZone()` by default — the process IANA
zone, consistent with how the orchestrator anchors the prompt date).

## Reminders & schedules (the time-triggered layer)

`agent_schedules` is extended (migration
[0030](../src/storage/migrations/0030_agent_schedules_cron.sql)) with `cron`,
`time_zone`, `notify_chat_id`. One table now covers:

| Row shape | Behaviour |
| --- | --- |
| agents set, `cron` set | dispatch those agents on the cron; ping `notify_chat_id` on task finish |
| agents set, legacy `recurrence` | unchanged (`once/daily/weekly/monthly/yearly`) |
| no agents, `notify_chat_id` set | **notify-only reminder** — the sweep emits a nudge of `prompt` |

The per-minute sweep ([agent-schedules.ts](../src/core/agent-schedules.ts))
advances a cron row via `nextFireAfter`; legacy rows keep `advanceNextRun`. A
notify-only fire becomes a deferred nudge, so it inherits quiet hours, the rate
limit, and dedup for free.

**Surfaces** — all routed through one shared creation path
([schedule-tools.ts](../src/core/schedule-tools.ts) `createScheduleFromText`):

- Chat model: the `create_schedule` tool (auto tier; hidden from agents, whose
  chat id is a pseudo id).
- Telegram: `/remind`, `/every`, `/schedules`, `/schedule cancel`
  ([schedule-commands.ts](../src/adapters/schedule-commands.ts)).
- Panel: `POST /api/agents/schedules/parse` previews the parse; the Schedule
  dialog's "Plain English" box uses it, then POSTs the structured row (now
  cron-aware).

## Heartbeat (the pulse)

[heartbeat.ts](../src/core/heartbeat.ts) registers **one** scheduled job at a
configurable cadence (default `*/30`, `MODULUS_HEARTBEAT_CRON` to override; an
invalid value falls back, never wedges boot). Each beat evaluates due standing
orders and returns their nudges. A quiet beat is a single SQL read — it only
enqueues an agent or emits a nudge when an order is actually due, so the "one
heavy model resident at a time" invariant and the Pi target hold. `lastBeatAt` +
cadence surface in `/status`.

## Standing orders (conditional agency)

Migration [0031](../src/storage/migrations/0031_standing_orders.sql) +
[standing-orders.ts](../src/core/standing-orders.ts). Where a schedule fires at a
fixed time, a standing order is *evaluated* each beat:

- **Agentic** (`agent_id` set): enqueue that agent with `instruction` and a
  notify target; the existing task-done pipeline delivers the answer.
- **Notify** (`agent_id` NULL): emit a nudge of `instruction`; with
  `notify_on_change`, only when a probed state differs from `last_state`.

Due-ness: a `cron` (matched in `time_zone`) pins coarse timing, else the order
re-evaluates once `cadence_ms` has elapsed (0/NULL = every beat). Precision is
bounded by the heartbeat cadence — minute-exact reminders are `agent_schedules`.

**Surfaces**: `/standing [add <agent>, <what> | cancel <id>]`
([standing-commands.ts](../src/adapters/standing-commands.ts)) and the panel's
Agents tab (`/api/agents/standing`).

## Invariants honoured

- **Deterministic prompt prefix**: heartbeat/standing/reminder output flows as
  nudges or background-queue tasks — no new prompt slot, KV cache untouched.
- **Reply ships first**: beats and firings are background work, never inline
  with a user turn.
- **Migrations**: two new numbered files (0030, 0031), append-only.
- **No hardcoded tz**: the parser takes an explicit zone; cron matching is
  already tz-aware.
- **Safe by default**: notify-only is low-risk and rate-limited; an agentic
  order inherits its agent's allowlist + the fail-closed approval path, so a
  confirm/owner-tier tool in an unattended beat parks for approval.
- **Modules are mods**: heartbeat/orders are core; a module can already register
  scheduled jobs with zero core change, so no module-facing API was forced.
