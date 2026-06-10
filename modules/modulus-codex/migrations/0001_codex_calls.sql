-- modulus-codex 0001_codex_calls
-- Ledger of Codex handoffs. One row per attempt (success, error, or refusal),
-- so the daily budget guard can count usage and /codexstatus can report it.
-- `day` is a local-date bucket (YYYY-MM-DD) computed by the extension using the
-- configured time_zone, so the ceiling resets at the user's local midnight.

CREATE TABLE IF NOT EXISTS codex_calls (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  day               TEXT    NOT NULL,
  chat_id           INTEGER,
  source            TEXT    NOT NULL DEFAULT 'tool',  -- 'tool' (qwen escalated) | 'command' (/codex)
  status            TEXT    NOT NULL,                 -- 'ok' | 'error' | 'denied'
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  created_at        INTEGER NOT NULL
);

-- The budget guard runs a COUNT(*) ... WHERE day = ? on every handoff; the
-- index keeps that O(log n) as the ledger grows.
CREATE INDEX IF NOT EXISTS idx_codex_calls_day ON codex_calls (day);
