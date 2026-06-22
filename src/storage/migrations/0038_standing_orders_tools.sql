-- 0038_standing_orders_tools: per-watch tool ceiling + pre-approval.
--
-- A watch routine runs a single agent on each due beat. These mirror what a
-- schedule step carries inside steps_json, but a standing order is a flat row,
-- so they need real columns:
--   * tools             — the agent's tool ceiling for this watch (a JSON array
--                         of module/tool names). NULL = no extra restriction:
--                         the agent may use any tool in its own allowlist.
--   * preapproved_tools — JSON array of confirm-tier tools allowed to run
--                         unattended without parking. NULL/empty = fail closed.
-- Both nullable, nothing to backfill — existing rows read as NULL and behave
-- exactly as before.
ALTER TABLE standing_orders ADD COLUMN tools TEXT;
ALTER TABLE standing_orders ADD COLUMN preapproved_tools TEXT;
