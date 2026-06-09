-- 0010_agent_schedules: user-created scheduled agent tasks.
--
-- A schedule can target one or more agents. The daemon's normal scheduler
-- sweeps this table every minute and enqueues one agent_tasks row per target
-- agent when next_run_at is due. One-shot schedules are deactivated after
-- firing; recurring schedules advance to the next daily or weekly run.

CREATE TABLE agent_schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- JSON array of agent ids. Schedules may target multiple agents without
  -- duplicating the user's prompt/date settings.
  agent_ids TEXT NOT NULL,
  prompt TEXT NOT NULL,
  next_run_at INTEGER NOT NULL,
  recurrence TEXT NOT NULL DEFAULT 'once'
    CHECK (recurrence IN ('once', 'daily', 'weekly')),
  active INTEGER NOT NULL DEFAULT 1,
  last_run_at INTEGER,
  -- JSON array of task ids created by the most recent fire.
  last_task_ids TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_agent_schedules_due ON agent_schedules (active, next_run_at, id);
