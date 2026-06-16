-- 0031_standing_orders: conditional, heartbeat-evaluated agency.
--
-- A standing order is the layer above a fixed reminder: instead of firing at a
-- set time, it is *evaluated* on each heartbeat and acts only when it should.
-- Two shapes:
--   * agentic   (agent_id set)  — enqueue that agent to carry out `instruction`
--                                 and report back to notify_chat_id. Inherits
--                                 the agent's tool gating, so a confirm/owner
--                                 tool still parks for approval in the run.
--   * notify    (agent_id NULL) — emit a nudge of `instruction` to
--                                 notify_chat_id; with notify_on_change, only
--                                 when an observed state differs from last_state.
--
-- Due-ness: a cron (matched in time_zone) pins coarse timing; otherwise the
-- order is re-evaluated whenever cadence_ms has elapsed since last_evaluated_at
-- (0/NULL = every beat). Precision is bounded by the heartbeat cadence, so cron
-- here is for "which days / roughly when", not minute-exact reminders (those are
-- agent_schedules).

CREATE TABLE standing_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instruction TEXT NOT NULL,
  agent_id INTEGER,
  notify_chat_id INTEGER,
  cron TEXT,
  time_zone TEXT,
  cadence_ms INTEGER,
  notify_on_change INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  last_evaluated_at INTEGER,
  last_fired_at INTEGER,
  last_state TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_standing_orders_active ON standing_orders (active, id);
