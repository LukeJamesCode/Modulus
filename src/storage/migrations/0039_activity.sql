-- 0039_activity: the durable Activity record.
--
-- An append-only index of headline things Modulus did, so the panel's Activity
-- tab can show a timeline (the wide shot) and a scrollable feed (the close-up)
-- that survive a restart. Existing tables already hold the DETAIL (agent_tasks,
-- messages, agent_schedules); a row here is a thin, queryable headline that
-- links back to that detail via (ref_table, ref_id) rather than copying it.
--
-- This is NOT the live "is it running right now" marker — that stays ephemeral
-- in chat-activity.ts. A row lands here only when something notable COMPLETED
-- (or was blocked), so the feed is a record of what happened, not what's live.
--
-- Immutable once shipped. Future schema changes get their own NNNN_*.sql.

CREATE TABLE activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- When the event happened (ms epoch). Distinct from created_at so a writer
  -- can backdate to the real finish time while created_at stays insert-time.
  ts INTEGER NOT NULL,
  -- What kind of thing happened. Open-ended on purpose (modules may append),
  -- but the first-party writers emit one of:
  --   chat_turn | agent_run | routine_fire | tool_call
  kind TEXT NOT NULL,
  -- Who did it: an agent name, or 'modulus' for the built-in assistant.
  actor TEXT NOT NULL,
  -- Why it ran — drives the timeline's colour bands:
  --   user | schedule | chat | delegation
  trigger TEXT NOT NULL,
  -- How it went — drives the feed's status chip:
  --   ok | failed | blocked | awaiting
  status TEXT NOT NULL,
  -- Plain-English one-liner shown in the feed ("Sent 1 email", "Ran morning
  -- brief, 4 tool calls"). Already user-facing; no rendering logic downstream.
  summary TEXT NOT NULL,
  -- Which chat surface it happened on (telegram | dashboard | <module>), or
  -- NULL when not surface-bound (a scheduled agent run with no chat).
  surface TEXT,
  -- Drill-in target: the existing detail row this headline summarises, so a
  -- feed click can open the full transcript/result. NULL = nothing to open.
  ref_table TEXT,
  ref_id INTEGER,
  created_at INTEGER NOT NULL
);

-- The feed reads newest-first; the timeline buckets by ts. One index covers
-- the common ORDER BY ts DESC and the range scans the timeline does.
CREATE INDEX idx_activity_ts ON activity (ts DESC);
-- Kind filter ("show me only tool calls") stays index-backed.
CREATE INDEX idx_activity_kind ON activity (kind, ts DESC);
