-- 0001_init: core conversation tables.
--
-- Real numbered migration. Future schema changes get their own NNNN_*.sql
-- file; this file is immutable once shipped. Do not edit it -- write a new
-- migration that adds/alters/backfills.

CREATE TABLE conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_chat_id INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);

CREATE INDEX idx_conversations_chat ON conversations (telegram_chat_id, ended_at);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
  content TEXT NOT NULL,
  tool_call_id TEXT,
  tool_name TEXT,
  tokens INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_messages_conv ON messages (conversation_id, id);

-- Compact running summary the context manager keeps in-budget, per
-- conversation. One row per conversation; updated by the background queue.
CREATE TABLE session_memory (
  conversation_id INTEGER PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Telegram chat state. Maps a chat to its current open conversation.
CREATE TABLE telegram_chats (
  chat_id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  current_conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  devmode INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_seen_at INTEGER NOT NULL
);

-- Scheduler primitives. Phase 1 ships them empty; Phase 6's proactive loop
-- will use them. Keep them in the initial migration so nothing has to migrate
-- later just to add a "tasks" table.
CREATE TABLE scheduled_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  cron TEXT NOT NULL,
  payload TEXT,
  next_run_at INTEGER NOT NULL,
  last_run_at INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX idx_scheduled_next ON scheduled_tasks (enabled, next_run_at);

CREATE TABLE job_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  enqueued_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  last_error TEXT
);

CREATE INDEX idx_jobs_status ON job_queue (status, id);
