-- 0005_nudge_metadata: make proactive nudges self-describing.
--
-- Keep the original nudge_log shape intact for compatibility, then add nullable
-- metadata columns that let the scheduler coordinate cross-extension routines
-- without understanding each extension's private tables.

ALTER TABLE nudge_log ADD COLUMN priority TEXT;
ALTER TABLE nudge_log ADD COLUMN category TEXT;
ALTER TABLE nudge_log ADD COLUMN source TEXT;
ALTER TABLE nudge_log ADD COLUMN reason TEXT;
ALTER TABLE nudge_log ADD COLUMN created_at INTEGER;
ALTER TABLE nudge_log ADD COLUMN expires_at INTEGER;
ALTER TABLE nudge_log ADD COLUMN actions_json TEXT;

CREATE INDEX idx_nudge_log_category_time ON nudge_log (category, sent_at);
CREATE INDEX idx_nudge_log_expires_at ON nudge_log (expires_at);
