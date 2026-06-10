-- modulus-assistant 0004_reschedule_proposals
-- Tracks the weather-driven auto-reschedule conversation per outdoor calendar
-- event. The weather sweep inserts a row in status='pending' and sends a
-- Yes/No nudge; the callback handlers walk it through 'proposed' → 'accepted'
-- / 'rejected' / 'forgotten'. declined_slots_json holds the ISO start times of
-- slots the user already rejected so we don't re-offer them on retry.

CREATE TABLE reschedule_proposals (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id             INTEGER NOT NULL,
  event_id            TEXT    NOT NULL,
  event_summary       TEXT,
  original_start      TEXT    NOT NULL,
  original_end        TEXT    NOT NULL,
  status              TEXT    NOT NULL DEFAULT 'pending',
  declined_slots_json TEXT    NOT NULL DEFAULT '[]',
  proposed_start      TEXT,
  proposed_end        TEXT,
  reason              TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

-- Dedup: at most one open proposal per (chat, event). The weather sweep checks
-- this index before creating a new row, so a sweep that re-detects the same
-- bad-weather event won't spam the user with a fresh "Reschedule?" prompt.
CREATE UNIQUE INDEX idx_reschedule_open
  ON reschedule_proposals (chat_id, event_id)
  WHERE status IN ('pending', 'proposed');

CREATE INDEX idx_reschedule_status ON reschedule_proposals (status);
