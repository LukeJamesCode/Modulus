-- 0003_proactive: per-chat proactive prefs + cross-extension nudge log.
--
-- Phase 6 polish. Two tables:
--
--   chat_prefs   — quiet hours and snooze state, keyed by Telegram chat.
--                  Quiet hours are a daily window in *local time*, stored as
--                  minute-of-day [0-1439]. start > end means the window wraps
--                  midnight (e.g. 22:00-07:00). Both NULL means no window.
--                  paused_until_ms is a one-shot snooze; NULL means not paused.
--
--   nudge_log    — append-only log of every nudge the scheduler actually
--                  dispatched. The scheduler reads it for cross-extension
--                  rate-limit + dedup so calendar + journal + habits don't
--                  pile three pings into the same minute, and so a dedup key
--                  survives a process restart.

CREATE TABLE chat_prefs (
  chat_id INTEGER PRIMARY KEY,
  quiet_start_minute INTEGER,
  quiet_end_minute INTEGER,
  paused_until_ms INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE nudge_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  extension TEXT NOT NULL,
  job TEXT NOT NULL,
  key TEXT,
  sent_at INTEGER NOT NULL
);

CREATE INDEX idx_nudge_log_chat_time ON nudge_log (chat_id, sent_at);
CREATE INDEX idx_nudge_log_key ON nudge_log (key, sent_at);
