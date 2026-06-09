// Per-chat proactive prefs. Quiet hours + snooze.
//
// Phase 6 — the bot needs to nudge proactively without spamming, and the user
// needs a clean way to mute it. The scheduler reads this store before
// dispatching a nudge; the Telegram /quiet command writes it.
//
// Quiet hours are stored as minute-of-day in the system's local TZ (per North
// Star: "no hardcoded timezones"). start > end means the window wraps
// midnight; both NULL means there is no daily window for this chat.
//
// paused_until_ms is a one-shot snooze. The scheduler clears it lazily by
// just letting it expire; we don't sweep the row.

import type { DB } from '../storage/db.js';

export interface ChatPrefs {
  chatId: number;
  quietStartMinute: number | null;
  quietEndMinute: number | null;
  pausedUntilMs: number | null;
}

export type QuietReason = 'paused' | 'window';

export interface QuietCheck {
  quiet: boolean;
  reason?: QuietReason;
  // For paused: when the snooze ends. For window: when the window ends today.
  // Useful for the /quiet status reply.
  until?: number;
}

export interface PrefsStore {
  get(chatId: number): ChatPrefs;
  setQuietWindow(chatId: number, startMinute: number | null, endMinute: number | null): void;
  setPausedUntil(chatId: number, untilMs: number | null): void;
  clear(chatId: number): void;
  isQuiet(chatId: number, at?: Date): QuietCheck;
}

const EMPTY: Omit<ChatPrefs, 'chatId'> = {
  quietStartMinute: null,
  quietEndMinute: null,
  pausedUntilMs: null,
};

export function createPrefsStore(db: DB): PrefsStore {
  function get(chatId: number): ChatPrefs {
    const row = db
      .prepare(
        `SELECT quiet_start_minute, quiet_end_minute, paused_until_ms
         FROM chat_prefs WHERE chat_id = ?`,
      )
      .get(chatId) as
      | {
          quiet_start_minute: number | null;
          quiet_end_minute: number | null;
          paused_until_ms: number | null;
        }
      | undefined;
    if (!row) return { chatId, ...EMPTY };
    return {
      chatId,
      quietStartMinute: row.quiet_start_minute,
      quietEndMinute: row.quiet_end_minute,
      pausedUntilMs: row.paused_until_ms,
    };
  }

  function upsert(
    chatId: number,
    patch: Partial<{
      quiet_start_minute: number | null;
      quiet_end_minute: number | null;
      paused_until_ms: number | null;
    }>,
  ): void {
    const existing = get(chatId);
    const merged = {
      quiet_start_minute:
        patch.quiet_start_minute === undefined
          ? existing.quietStartMinute
          : patch.quiet_start_minute,
      quiet_end_minute:
        patch.quiet_end_minute === undefined ? existing.quietEndMinute : patch.quiet_end_minute,
      paused_until_ms:
        patch.paused_until_ms === undefined ? existing.pausedUntilMs : patch.paused_until_ms,
    };
    db.prepare(
      `INSERT INTO chat_prefs
         (chat_id, quiet_start_minute, quiet_end_minute, paused_until_ms, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET
         quiet_start_minute = excluded.quiet_start_minute,
         quiet_end_minute = excluded.quiet_end_minute,
         paused_until_ms = excluded.paused_until_ms,
         updated_at = excluded.updated_at`,
    ).run(
      chatId,
      merged.quiet_start_minute,
      merged.quiet_end_minute,
      merged.paused_until_ms,
      Date.now(),
    );
  }

  function setQuietWindow(
    chatId: number,
    startMinute: number | null,
    endMinute: number | null,
  ): void {
    upsert(chatId, { quiet_start_minute: startMinute, quiet_end_minute: endMinute });
  }

  function setPausedUntil(chatId: number, untilMs: number | null): void {
    upsert(chatId, { paused_until_ms: untilMs });
  }

  function clear(chatId: number): void {
    db.prepare(`DELETE FROM chat_prefs WHERE chat_id = ?`).run(chatId);
  }

  function isQuiet(chatId: number, at: Date = new Date()): QuietCheck {
    const p = get(chatId);
    const nowMs = at.getTime();
    if (p.pausedUntilMs !== null && p.pausedUntilMs > nowMs) {
      return { quiet: true, reason: 'paused', until: p.pausedUntilMs };
    }
    if (p.quietStartMinute !== null && p.quietEndMinute !== null) {
      const mod = at.getHours() * 60 + at.getMinutes();
      const s = p.quietStartMinute;
      const e = p.quietEndMinute;
      const inWindow = s === e ? false : s < e ? mod >= s && mod < e : mod >= s || mod < e;
      if (inWindow) {
        // Compute when the window ends today (or tomorrow if it wraps).
        const end = new Date(at);
        end.setSeconds(0, 0);
        end.setHours(Math.floor(e / 60), e % 60);
        if (end.getTime() <= nowMs) end.setDate(end.getDate() + 1);
        return { quiet: true, reason: 'window', until: end.getTime() };
      }
    }
    return { quiet: false };
  }

  return { get, setQuietWindow, setPausedUntil, clear, isQuiet };
}

// Format a "HH:MM-HH:MM" window string. Returns null if either bound is null.
export function formatWindow(startMinute: number | null, endMinute: number | null): string | null {
  if (startMinute === null || endMinute === null) return null;
  return `${formatHm(startMinute)}-${formatHm(endMinute)}`;
}

function formatHm(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}

// Parse a "HH:MM-HH:MM" or "H-H" window. Returns null if not parseable.
export function parseWindow(raw: string): { start: number; end: number } | null {
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*-\s*(\d{1,2})(?::(\d{2}))?\s*$/.exec(raw);
  if (!m) return null;
  const sh = Number(m[1]);
  const sm = m[2] === undefined ? 0 : Number(m[2]);
  const eh = Number(m[3]);
  const em = m[4] === undefined ? 0 : Number(m[4]);
  if (sh > 23 || eh > 23 || sm > 59 || em > 59) return null;
  return { start: sh * 60 + sm, end: eh * 60 + em };
}

// Parse a "1h", "30m", "45s" duration. Returns ms, or null if not parseable.
export function parseDuration(raw: string): number | null {
  const m = /^\s*(\d+)\s*([smhd])\s*$/i.exec(raw);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  const mult = unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return n * mult;
}
