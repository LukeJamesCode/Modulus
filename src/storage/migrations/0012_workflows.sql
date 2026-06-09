-- 0012_workflows: design-time multi-agent workflows (n8n-style).
--
-- Unlike agent delegation (where the model decides routing at run time via the
-- spawn_agent tool), a workflow is an *authored* DAG: a user wires agent, tool,
-- transform, condition, loop and output nodes on a canvas and the runner walks
-- it deterministically (code routes; the model only runs inside agent nodes).
--
-- The control panel (a separate process) authors `workflows` and enqueues a
-- `workflow_runs` row; the daemon's WorkflowRunner polls for queued runs and
-- executes the DAG in-process, writing one `workflow_step_runs` row per node so
-- the UI can light up live. This mirrors how the agent queue/approvals already
-- cross the panel<->daemon process boundary via the DB.
--
-- Immutable once shipped. Future schema changes get their own NNNN_*.sql.

CREATE TABLE workflows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  -- The authored graph: { nodes: [...], edges: [...] }. Validated on write by
  -- the WorkflowRegistry (unique node ids, exactly one trigger, acyclic, every
  -- edge references existing nodes).
  graph_json TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- One row per execution of a workflow. The panel inserts a 'queued' row; the
-- daemon claims it (UPDATE ... WHERE status='queued') and drives the DAG,
-- streaming the final result into `output`/`error`.
CREATE TABLE workflow_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id INTEGER NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'done', 'error', 'cancelled')),
  -- JSON of the run input ({ input: "..." } seeded as {{trigger.input}}). NULL
  -- when the workflow takes no input.
  input_json TEXT,
  output TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);

-- One row per node execution within a run. `node_id` is the graph node id
-- (a string, e.g. "a1"); for an agent node, `agent_task_id` links the
-- agent_tasks row it produced so the existing mission-control view can surface
-- the transcript. Skipped branches never get a row.
CREATE TABLE workflow_step_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  node_type TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'done', 'error', 'skipped')),
  output TEXT,
  error TEXT,
  agent_task_id INTEGER,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);

-- Daemon poll: cheapest claim of the oldest queued run.
CREATE INDEX idx_workflow_runs_runnable ON workflow_runs (status, id);
CREATE INDEX idx_workflow_runs_workflow ON workflow_runs (workflow_id, id);
CREATE INDEX idx_workflow_step_runs_run ON workflow_step_runs (run_id, id);
