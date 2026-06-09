-- 0017_agent_autonomy: long-horizon "autonomous" agent support
--
-- Adds long-horizon "autonomous" agent support: a plan/todo loop, budget ceilings, 
-- mid-run steer queue, step checkpoints for durable resume, and saved artifacts.

ALTER TABLE agents ADD COLUMN mode TEXT NOT NULL DEFAULT 'single' CHECK (mode IN ('single', 'autonomous'));
ALTER TABLE agents ADD COLUMN max_wall_clock_ms INTEGER;
ALTER TABLE agents ADD COLUMN max_total_rounds INTEGER;

ALTER TABLE agent_tasks ADD COLUMN plan_json TEXT;
ALTER TABLE agent_tasks ADD COLUMN step_cursor INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_tasks ADD COLUMN rounds_used INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_tasks ADD COLUMN steer_queue_json TEXT;
ALTER TABLE agent_tasks ADD COLUMN checkpoint_at INTEGER;

CREATE TABLE agent_artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  mime TEXT NOT NULL DEFAULT 'text/plain',
  content TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_agent_artifacts_task ON agent_artifacts (task_id, id);
