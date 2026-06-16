-- 0027_chat_think_mode: per-chat reasoning mode for chat surfaces.
--
-- The chat tab toggles thinking per turn, but a Telegram chat has no toggle, so
-- /think and /fast set a sticky per-chat default the dispatcher applies to every
-- turn (mirroring how devmode persists on the chat row). 'auto' keeps the prior
-- behaviour (each model's default), so existing chats are unchanged.

ALTER TABLE telegram_chats
  ADD COLUMN think_mode TEXT NOT NULL DEFAULT 'auto'
    CHECK (think_mode IN ('auto', 'on', 'off'));
