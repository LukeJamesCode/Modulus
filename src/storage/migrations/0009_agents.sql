-- 0009_agents: multi-agent engine.
--
-- `agents` holds named personas: a saved bundle of orchestrator options
-- (system prompt, model profile, tool allowlist, tool-round cap) plus the
-- execution policy (sequential|parallel, concurrency) and delegation grant.
-- An agent run reuses the normal orchestrator pipeline against a reserved
-- "virtual" chat id, so its transcript lands in conversations/messages like
-- any other chat; `agent_tasks.conversation_id` links a task to that row.
--
-- Immutable once shipped. Future schema changes get their own NNNN_*.sql.

CREATE TABLE agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT '',
  system_prompt TEXT NOT NULL,
  -- JSON array of extension names and/or specific tool names; NULL = all tools.
  tool_allowlist TEXT,
  profile TEXT NOT NULL DEFAULT 'chat' CHECK (profile IN ('chat', 'reason', 'tools')),
  max_tool_rounds INTEGER NOT NULL DEFAULT 4,
  -- NULL => orchestrator default (profile context budget).
  budget_tokens INTEGER,
  execution_mode TEXT NOT NULL DEFAULT 'sequential'
    CHECK (execution_mode IN ('sequential', 'parallel')),
  max_concurrency INTEGER NOT NULL DEFAULT 1,
  can_delegate INTEGER NOT NULL DEFAULT 0,
  -- JSON array of agent names this agent may spawn; [] with can_delegate=1
  -- means "any agent". Ignored when can_delegate=0.
  delegatable_agents TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- One row per dispatched task (top-level or a delegated sub-task). The queue
-- (Phase 2) dequeues by status + priority; the runner streams the result back
-- into `result`/`error` and links the conversation row it produced.
CREATE TABLE agent_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  -- Set when this task was spawned by another task (supervisor -> worker).
  parent_id INTEGER REFERENCES agent_tasks(id) ON DELETE SET NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'done', 'error', 'cancelled')),
  execution_mode TEXT NOT NULL DEFAULT 'sequential'
    CHECK (execution_mode IN ('sequential', 'parallel')),
  priority INTEGER NOT NULL DEFAULT 0,
  -- Delegation depth; 0 for a user-dispatched task. Capped by the spawn tool.
  depth INTEGER NOT NULL DEFAULT 0,
  -- The conversation row this run wrote its transcript into (reserved virtual
  -- chat id = AGENT_CHAT_ID_BASE + id). NULL until the run starts.
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  virtual_chat_id INTEGER,
  -- Delegation grant ceiling: a JSON array of extension/tool names the parent
  -- was allowed to use, ANDed with the worker's own allowlist at run time so a
  -- delegated worker can never exceed the supervisor's grant. NULL = no extra
  -- restriction (top-level task, or a parent with an unrestricted grant).
  tool_allowlist_override TEXT,
  result TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);

CREATE INDEX idx_agent_tasks_runnable ON agent_tasks (status, priority DESC, id);
CREATE INDEX idx_agent_tasks_agent ON agent_tasks (agent_id, id);
CREATE INDEX idx_agent_tasks_parent ON agent_tasks (parent_id);
