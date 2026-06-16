-- 0030_agent_schedules_cron: give agent_schedules a cron spine + notify target.
--
-- Until now a schedule fired on a fixed next_run_at advanced by a coarse
-- recurrence enum (once/daily/weekly/monthly/yearly). 1.3.0 unifies natural-
-- language scheduling, reminders, and agent schedules on one primitive: a
-- 5-field cron string matched in an explicit IANA time zone (the same engine
-- the scheduler already uses for module jobs). Legacy recurrence rows keep
-- working — the sweep advances a row via nextFireAfter() when `cron` is set,
-- and via the old advanceNextRun() otherwise.
--
-- notify_chat_id turns agent_schedules into the reminder spine too: a row with
-- an empty agent_ids array ('[]') and a notify_chat_id is a notify-only
-- reminder — the sweep emits a nudge of `prompt` to that chat instead of
-- dispatching an agent task. A row with agents AND a notify_chat_id pings that
-- chat when the dispatched task finishes (same contract as agent_tasks).
--
-- Plain ADD COLUMN, nullable, no defaults to backfill — existing rows read as
-- cron=NULL / time_zone=NULL / notify_chat_id=NULL and behave exactly as before.

ALTER TABLE agent_schedules ADD COLUMN cron TEXT;
ALTER TABLE agent_schedules ADD COLUMN time_zone TEXT;
ALTER TABLE agent_schedules ADD COLUMN notify_chat_id INTEGER;
