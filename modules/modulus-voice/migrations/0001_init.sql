-- modulus-voice 0001_init: per-chat voice preference. One row per chat the user
-- has touched /voice for; the after-reply hook reads this table to decide
-- whether to synthesize.
--
-- IF NOT EXISTS because the extension was previously shipped under the name
-- `modulus-tts`, which created the same table under its own migration tracker.
-- A user upgrading would otherwise hit "table tts_chat_prefs already exists"
-- the first time modulus-voice's fresh migration tracker tries to run this.

CREATE TABLE IF NOT EXISTS tts_chat_prefs (
  chat_id INTEGER PRIMARY KEY,
  enabled INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
