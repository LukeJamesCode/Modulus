-- modulus-computer-use 0001_init
-- Audit trail for desktop-operator sessions. Every session and every action it
-- takes is recorded here so a run is fully reviewable after the fact and the
-- panel's live monitor has a table to tail. stop_requested is the Stop channel
-- the running loop polls each iteration, so the panel (a separate layer) can
-- halt a session without reaching into module code.

CREATE TABLE IF NOT EXISTS computer_use_sessions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  goal           TEXT    NOT NULL,
  chat_id        INTEGER,                            -- originating Telegram chat, if any
  status         TEXT    NOT NULL DEFAULT 'running', -- running|done|stopped|error|paused
  stop_requested INTEGER NOT NULL DEFAULT 0,         -- Stop flag the loop polls each step
  summary        TEXT,
  started_at     INTEGER NOT NULL,
  finished_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_cu_sessions_status ON computer_use_sessions (status, id);

CREATE TABLE IF NOT EXISTS computer_use_steps (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  INTEGER NOT NULL,
  step_no     INTEGER NOT NULL,
  action      TEXT    NOT NULL,                 -- click|type|key|scroll|drag|wait|done|ask
  args_json   TEXT    NOT NULL DEFAULT '{}',
  rationale   TEXT,                             -- the model's stated reason for this action
  foreground  TEXT,                             -- "process | title" at capture time
  screenshot  TEXT,                             -- absolute path to the PNG seen this step
  outcome     TEXT    NOT NULL,                 -- ok|blocked|error|skipped
  detail      TEXT,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES computer_use_sessions(id)
);
CREATE INDEX IF NOT EXISTS idx_cu_steps_session ON computer_use_steps (session_id, step_no);
