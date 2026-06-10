CREATE TABLE IF NOT EXISTS minimax_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,
  chat_id INTEGER,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_minimax_calls_day ON minimax_calls(day);
