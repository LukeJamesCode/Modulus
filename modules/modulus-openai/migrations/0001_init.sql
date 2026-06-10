-- modulus-openai 0001_init
-- Per-endpoint daily usage ledger. Rows include successes, backend errors, and
-- budget refusals so /oaistatus can explain what happened today.

CREATE TABLE IF NOT EXISTS openai_compat_usage (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  day               TEXT    NOT NULL,
  endpoint_alias    TEXT    NOT NULL,
  chat_id           INTEGER,
  source            TEXT    NOT NULL DEFAULT 'llm',
  status            TEXT    NOT NULL,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  created_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_openai_compat_usage_day_alias
  ON openai_compat_usage (day, endpoint_alias);
