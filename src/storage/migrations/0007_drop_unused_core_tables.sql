-- 0007_drop_unused_core_tables: remove pre-1.0 core ballast.
--
-- These tables were created early as placeholders but never became the
-- production extension/scheduler path. Extensions use the in-memory scheduler
-- registry plus their own migrations, and post-turn async work uses extension
-- hooks rather than a core job queue.

DROP TABLE IF EXISTS scheduled_tasks;
DROP TABLE IF EXISTS job_queue;
DROP TABLE IF EXISTS session_memory;
