-- 0036_agent_schedules_steps: multi-step routines.
--
-- A schedule could already run agents at a time/cron. This adds an authored,
-- ordered step list so a routine can run several agents in sequence, threading
-- each step's output into the next and skipping a step on a simple condition —
-- the "linear step list" the Routines tab exposes (NOT an n8n DAG; that was cut
-- in 0029). steps_json is [{agentId, instruction, condition?}]; agentId NULL is
-- a "just message me this" step. The routine-runner walks it.
--
-- Back-compat: steps_json NULL = the legacy single-step behaviour (agent_ids +
-- prompt, fire-and-forget). The panel only writes steps_json for a routine with
-- two or more steps, so simple schedules keep their exact prior path.
--
-- last_status / last_result record the outcome of the most recent run so the
-- Routines list can show a "ran ✓ / failed" trust line.
--
-- Plain ADD COLUMN, nullable, nothing to backfill — existing rows read as
-- steps_json=NULL / last_status=NULL / last_result=NULL and behave as before.

ALTER TABLE agent_schedules ADD COLUMN steps_json TEXT;
ALTER TABLE agent_schedules ADD COLUMN last_status TEXT;
ALTER TABLE agent_schedules ADD COLUMN last_result TEXT;
