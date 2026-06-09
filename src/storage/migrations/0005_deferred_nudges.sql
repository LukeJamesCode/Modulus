-- 0005_deferred_nudges: persisted nudge queue.
--
-- Important proactive nudges can opt into deferral when quiet hours or the
-- cross-extension rate limit would otherwise suppress them. The scheduler's
-- core deferred-nudge sweep retries due rows each minute and marks delivered
-- rows for audit. Expired rows are discarded by the sweep instead of being
-- sent stale.

CREATE TABLE deferred_nudges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  extension TEXT NOT NULL,
  job TEXT NOT NULL,
  key TEXT,
  text TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high')),
  not_before INTEGER NOT NULL,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER
);

CREATE INDEX idx_deferred_nudges_due ON deferred_nudges (delivered_at, not_before, expires_at);
CREATE INDEX idx_deferred_nudges_chat_due ON deferred_nudges (chat_id, delivered_at, not_before);
CREATE UNIQUE INDEX idx_deferred_nudges_key_pending
  ON deferred_nudges (key)
  WHERE key IS NOT NULL AND delivered_at IS NULL;
