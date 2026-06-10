-- modulus-assistant 0003_learned_routines
-- Adopt learned-routine behavior from the (now-removed) modulus-routines extension.
-- Auto-accept design: no candidates/suggestions tables — the learner writes
-- directly into routine_rules and the per-minute delivery cron fires them.

-- Drop the old modulus-routines tables if a previous install left them behind.
-- routine_candidates and routine_suggestions are no longer used at all; the
-- routine_rules/routine_events tables get recreated below with the new schema.
DROP TABLE IF EXISTS routine_candidates;
DROP TABLE IF EXISTS routine_suggestions;
DROP TABLE IF EXISTS routine_rules;
DROP TABLE IF EXISTS routine_events;

CREATE TABLE routine_rules (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern_key       TEXT    NOT NULL UNIQUE,
  chat_id           INTEGER NOT NULL,
  title             TEXT    NOT NULL,
  cron              TEXT    NOT NULL,
  text              TEXT    NOT NULL,
  source_extensions TEXT    NOT NULL,
  confidence        REAL    NOT NULL,
  evidence_json     TEXT    NOT NULL,
  status            TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','deleted')),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX idx_routine_rules_status ON routine_rules (status, chat_id);

CREATE TABLE routine_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id    INTEGER REFERENCES routine_rules(id) ON DELETE SET NULL,
  chat_id    INTEGER NOT NULL,
  event_type TEXT    NOT NULL,
  detail     TEXT,
  event_at   INTEGER NOT NULL
);
CREATE INDEX idx_routine_events_rule_time ON routine_events (rule_id, event_at);
CREATE INDEX idx_routine_events_type_time ON routine_events (event_type, event_at);
