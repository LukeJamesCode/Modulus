-- 0014_agent_schedules_recurrence: widen the recurrence CHECK constraint to
-- include 'monthly' and 'yearly'.
--
-- 0010 shipped agent_schedules with CHECK (recurrence IN
-- ('once','daily','weekly')). The schedule code (AgentScheduleRecurrence,
-- normalizeRecurrence, advanceNextRun) and the frontend recurrence picker were
-- later extended to support 'monthly' and 'yearly', but the constraint never
-- was — so creating a monthly/yearly schedule failed at the DB layer with
-- SQLITE_CONSTRAINT_CHECK. SQLite can't alter a CHECK in place, so rebuild the
-- table with the wider constraint and copy the existing rows across. (No
-- foreign keys reference this table, so a plain rebuild inside the migration
-- transaction is safe.)

CREATE TABLE agent_schedules_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_ids TEXT NOT NULL,
  prompt TEXT NOT NULL,
  next_run_at INTEGER NOT NULL,
  recurrence TEXT NOT NULL DEFAULT 'once'
    CHECK (recurrence IN ('once', 'daily', 'weekly', 'monthly', 'yearly')),
  active INTEGER NOT NULL DEFAULT 1,
  last_run_at INTEGER,
  last_task_ids TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO agent_schedules_new
  (id, agent_ids, prompt, next_run_at, recurrence, active,
   last_run_at, last_task_ids, created_at, updated_at)
SELECT
  id, agent_ids, prompt, next_run_at, recurrence, active,
  last_run_at, last_task_ids, created_at, updated_at
FROM agent_schedules;

DROP TABLE agent_schedules;
ALTER TABLE agent_schedules_new RENAME TO agent_schedules;

CREATE INDEX idx_agent_schedules_due ON agent_schedules (active, next_run_at, id);
