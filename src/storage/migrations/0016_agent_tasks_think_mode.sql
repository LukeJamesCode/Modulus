-- 0016_agent_tasks_think_mode: per-run thinking override on a task.
--
-- The agent record carries a default thinking mode (0015); this column lets a
-- single dispatch (or a workflow agent node) override it for just that run
-- without editing the agent. NULL means "inherit the agent's think_mode", so
-- existing/queued tasks are unaffected. When set, it wins over the agent
-- default for that run (applied as the per-turn thinkMode in createAgentRuntime).

ALTER TABLE agent_tasks
  ADD COLUMN think_mode TEXT
    CHECK (think_mode IS NULL OR think_mode IN ('auto', 'on', 'off'));
