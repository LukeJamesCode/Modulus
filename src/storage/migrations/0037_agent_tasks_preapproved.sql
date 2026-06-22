-- 0037_agent_tasks_preapproved: per-run pre-approved confirm-tier tools.
--
-- A routine (schedule step or watch) may pre-authorize specific confirm-tier
-- tools so the unattended run executes them WITHOUT parking for a human Yes/No.
-- This carries that user-authored grant into the task. It is confirm-tier only
-- by construction (the gate's isToolPreapproved checks the handler's tier);
-- owner-tier tools always still park. NULL/empty = nothing pre-approved = the
-- existing fail-closed behaviour (a confirm-tier call parks for approval).
ALTER TABLE agent_tasks ADD COLUMN preapproved_tools TEXT;
