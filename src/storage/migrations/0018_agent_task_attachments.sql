-- 0018_agent_task_attachments: dropped-in inputs for an agent task
--
-- Lets a task carry input files/folders/images/PDFs. Metadata lives here; the
-- bytes live on disk under ~/.modulus/agent-attachments/<task_id>/ (text/code +
-- extracted PDF text under files/, images under images/). `path` is relative to
-- that per-task directory. Mirrors agent_artifacts (0017) but for INPUTS.

CREATE TABLE agent_task_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('file', 'image', 'pdf')),
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  mime TEXT NOT NULL DEFAULT 'application/octet-stream',
  bytes INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_agent_task_attachments_task ON agent_task_attachments (task_id, id);
