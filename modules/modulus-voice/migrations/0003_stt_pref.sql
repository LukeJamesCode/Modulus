-- modulus-voice 0003_stt_pref: per-chat opt-in for voice-to-text transcription.
-- Same row as the TTS-out preference — we keep both flags in one table so the
-- handler reads a single row per chat instead of joining across two.

ALTER TABLE tts_chat_prefs ADD COLUMN stt_enabled INTEGER NOT NULL DEFAULT 0;
