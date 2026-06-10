// Tiny wrapper around the per-chat preference table. Centralizing this keeps
// commands.ts and jobs.ts from duplicating the same SQL.

import type { DB } from '../../src/storage/db.js';

export function getPref(db: DB, chatId: number, fallback: boolean): boolean {
  const row = db.prepare(`SELECT enabled FROM tts_chat_prefs WHERE chat_id = ?`).get(chatId) as
    | { enabled: number }
    | undefined;
  if (!row) return fallback;
  return row.enabled !== 0;
}

export function setPref(db: DB, chatId: number, enabled: boolean): void {
  db.prepare(
    `INSERT INTO tts_chat_prefs (chat_id, enabled, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
  ).run(chatId, enabled ? 1 : 0, Date.now());
}

// Voice-in (STT) pref. Lives in the same row as the TTS-out pref so handlers
// read a single row per chat. Defaults to off — users opt in via /voice
// transcribe on.
export function getSttPref(db: DB, chatId: number, fallback: boolean): boolean {
  const row = db.prepare(`SELECT stt_enabled FROM tts_chat_prefs WHERE chat_id = ?`).get(chatId) as
    | { stt_enabled: number }
    | undefined;
  if (!row) return fallback;
  return row.stt_enabled !== 0;
}

export function setSttPref(db: DB, chatId: number, enabled: boolean): void {
  // UPSERT against the composite row. Inserting a fresh row defaults
  // `enabled` to 0 (TTS-out off) which is the right behavior — turning on
  // /voice transcribe shouldn't flip TTS-out on too.
  db.prepare(
    `INSERT INTO tts_chat_prefs (chat_id, enabled, stt_enabled, updated_at)
     VALUES (?, 0, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET stt_enabled = excluded.stt_enabled, updated_at = excluded.updated_at`,
  ).run(chatId, enabled ? 1 : 0, Date.now());
}

// Set both directions in one shot. `/voice on|off` uses this so the user gets
// a complete two-way voice flow (TTS replies + STT on voice notes) without
// having to also remember `/voice transcribe on`.
export function setBothPrefs(db: DB, chatId: number, enabled: boolean): void {
  const v = enabled ? 1 : 0;
  db.prepare(
    `INSERT INTO tts_chat_prefs (chat_id, enabled, stt_enabled, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET
       enabled = excluded.enabled,
       stt_enabled = excluded.stt_enabled,
       updated_at = excluded.updated_at`,
  ).run(chatId, v, v, Date.now());
}

// Telegram voice notes break down on huge replies (long encoding, awkward
// listening UX). We strip Markdown-y noise the LLM might emit and cap length.
export function prepForSpeech(text: string, maxChars: number): string | null {
  // Remove fenced code blocks entirely — speaking code is useless.
  const noFences = text.replace(/```[\s\S]*?```/g, ' [code omitted] ');
  // Strip inline-code backticks and Markdown emphasis characters.
  const cleaned = noFences
    .replace(/`([^`]*)`/g, '$1')
    .replace(/[*_~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  if (cleaned.length > maxChars) return null;
  return cleaned;
}
