# modulus-voice

Two-way Telegram voice: Piper TTS replies + whisper.cpp voice-note transcription.

User-facing docs live in [/docs/extensions/modulus-voice.md](../../docs/extensions/modulus-voice.md).

This folder holds the runtime code: manifest, post-reply hook (TTS-out), voice-message handler (STT-in), auth (voice picker), native-dep setup, settings schema. Edit the docs file (not this stub) when behaviour changes.

This extension was renamed from `modulus-tts` in 0.2.0. Existing user settings and per-chat preferences are migrated automatically on first load.
