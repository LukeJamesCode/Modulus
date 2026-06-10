-- Per-extension state for modulus-discord.
--
-- discord_chats: stable mapping from a (discord_user_id, discord_channel_id)
-- pair to the synthetic modulus_chat_id used as ctx.chatId for orchestrator
-- turns. Synthetic IDs are negative integers in a fixed namespace
-- (DISCORD_CHAT_ID_BASE in lib/identity.ts) so the surface router can claim
-- them via ownsChat() without colliding with Telegram's positive user IDs
-- or its negative supergroup IDs (which sit in a different range).
CREATE TABLE IF NOT EXISTS discord_chats (
  modulus_chat_id INTEGER PRIMARY KEY,
  discord_user_id TEXT NOT NULL,
  discord_channel_id TEXT NOT NULL,
  is_dm INTEGER NOT NULL DEFAULT 0,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  UNIQUE (discord_user_id, discord_channel_id)
);

CREATE INDEX IF NOT EXISTS idx_discord_chats_last_seen
  ON discord_chats(last_seen_at);
