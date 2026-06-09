-- 0013_agent_tasks_paused: add 'paused' status and paused_until to agent tasks.
--
-- SQLite does not support ALTER TABLE ... ADD CHECK or modifying existing CHECK
-- constraints, so we recreate the table. The new status 'paused' allows a user
-- to pause a workflow indefinitely or until a specific timestamp
-- (paused_until). The daemon's agent queue sweeps paused tasks whose
-- paused_until has passed and re-queues them automatically.

CREATE TABLE agent_tasks_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  parent_id INTEGER REFERENCES agent_tasks(id) ON DELETE SET NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'done', 'error', 'cancelled', 'paused')),
  execution_mode TEXT NOT NULL DEFAULT 'sequential'
    CHECK (execution_mode IN ('sequential', 'parallel')),
  priority INTEGER NOT NULL DEFAULT 0,
  depth INTEGER NOT NULL DEFAULT 0,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  virtual_chat_id INTEGER,
  tool_allowlist_override TEXT,
  result TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  paused_until INTEGER
);

INSERT INTO agent_tasks_new
  (id, agent_id, parent_id, prompt, status, execution_mode, priority, depth,
   conversation_id, virtual_chat_id, tool_allowlist_override, result, error,
   created_at, started_at, finished_at, paused_until)
SELECT
  id, agent_id, parent_id, prompt, status, execution_mode, priority, depth,
  conversation_id, virtual_chat_id, tool_allowlist_override, result, error,
  created_at, started_at, finished_at, NULL
FROM agent_tasks;

DROP TABLE agent_tasks;
ALTER TABLE agent_tasks_new RENAME TO agent_tasks;

CREATE INDEX idx_agent_tasks_runnable ON agent_tasks (status, priority DESC, id);
CREATE INDEX idx_agent_tasks_agent ON agent_tasks (agent_id, id);
CREATE INDEX idx_agent_tasks_parent ON agent_tasks (parent_id);
