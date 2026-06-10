-- modulus-assistant 0001_init
-- Fresh schema for the assistant's own tables. (The Gurney build shipped a
-- legacy migration here that adopted settings from five older separately-
-- installed extensions via the core extension_settings table; that table was
-- renamed to module_settings and those legacy modules never existed in Modulus,
-- so the adoption step is dropped — Modulus installs start clean.)

CREATE TABLE IF NOT EXISTS reminders (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id    INTEGER NOT NULL,
  text       TEXT    NOT NULL,
  fire_at    INTEGER NOT NULL,
  fired      INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reminders_sweep ON reminders (fired, fire_at);

CREATE TABLE IF NOT EXISTS calendar_nudges_sent (
  event_id    TEXT    NOT NULL,
  fire_minute INTEGER NOT NULL,
  chat_id     INTEGER NOT NULL,
  sent_at     INTEGER NOT NULL,
  PRIMARY KEY (event_id, fire_minute, chat_id)
);
CREATE INDEX IF NOT EXISTS idx_calendar_nudges_recent ON calendar_nudges_sent (sent_at);
