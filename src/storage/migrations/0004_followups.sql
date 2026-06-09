-- 0004_followups: self-scheduled followups.
--
-- A "followup" is a one-shot future message the model has committed to send
-- to the user. The model produces them via the core `schedule_followup` tool
-- ("remind me to take the chicken out at 5"); the scheduler sweeps the table
-- once a minute and emits a Nudge for each due row.
--
-- Distinct from `scheduled_tasks` (cron, recurring, extension-supplied) and
-- `job_queue` (background work that doesn't reach the user). One-shot, user-
-- visible, model-authored.
--
-- fired_at is set on a successful sweep dispatch. Rows are kept for audit
-- (a future /followups command can list past ones); a periodic GC of old
-- rows can be added later if it ever matters.

CREATE TABLE followups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  due_at INTEGER NOT NULL,
  topic TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  fired_at INTEGER
);

CREATE INDEX idx_followups_pending ON followups (fired_at, due_at);
