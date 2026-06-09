-- Live, in-progress reasoning/output for a running agent task.
--
-- The web panel runs in a separate process from the daemon and can only read the
-- DB (it never sees the daemon's in-memory stream events), so the autonomous loop
-- throttle-writes the current turn's streaming reasoning here (~1/s) for the run
-- view to display as the model "thinks". Transient: overwritten each turn and
-- cleared when the task finishes. Nullable; existing rows need no backfill.
ALTER TABLE agent_tasks ADD COLUMN live_text TEXT;
