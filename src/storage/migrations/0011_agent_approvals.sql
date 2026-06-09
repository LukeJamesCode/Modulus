-- 0011_agent_approvals: human-in-the-loop approvals for risky agent actions.
--
-- When a background agent task tries to run a 'confirm'-tier tool (or calls the
-- built-in request_approval tool), the daemon parks the call and writes a row
-- here, then asks the owner to approve via Telegram (Yes/No) and/or the control
-- panel. The parked call resolves once status leaves 'pending'. Rows are kept
-- after a decision so the panel can show recent history.

CREATE TABLE agent_approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- The agent_tasks row this approval gates. Not a FK: tasks may be pruned
  -- independently and an orphaned approval row is harmless (shown as history).
  task_id INTEGER NOT NULL,
  agent_id INTEGER,
  agent_name TEXT NOT NULL DEFAULT '',
  tool_name TEXT NOT NULL,
  -- The human-facing question (a tool's confirmPrompt, or the agent's reason).
  preview TEXT NOT NULL,
  -- JSON of the tool-call arguments, for audit/detail in the panel.
  args_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  -- Where the decision came from: 'telegram', 'panel', 'cancelled', 'restart'.
  decided_by TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);

CREATE INDEX idx_agent_approvals_status ON agent_approvals (status, id);
CREATE INDEX idx_agent_approvals_task ON agent_approvals (task_id);
