// Identity adapter. The core orchestrator's chatId is a JavaScript `number`
// (it has always been a Telegram chat id). Discord snowflakes are 64-bit
// integers that exceed Number.MAX_SAFE_INTEGER, so we cannot use them
// directly. We assign each (discord_user_id, discord_channel_id) pair a
// synthetic negative integer drawn from a private namespace and persist
// the mapping in this extension's SQLite table.
//
// Range:
//   DISCORD_CHAT_ID_BASE      = -8_000_000_000_001
//   DISCORD_CHAT_ID_MIN_BOUND = -8_999_999_999_999
//
// Telegram user IDs are positive; Telegram supergroup IDs follow the
// `-100<…>` pattern (≤ -1_000_000_000_000_000, i.e. 15+ digits negative)
// and Telegram basic-group IDs sit in (-1_000_000_000, 0). Our range
// is strictly between those and so will not collide.
//
// ownsChat() is used by the core confirm-router: it returns true iff the
// chatId falls inside this range, which is fast and avoids a DB hit on the
// confirm hot path. A pair is *registered* lazily by chatIdFor() on the
// first message we see; the row is the canonical record for that pair.

import { createHash } from 'node:crypto';
import type { DB } from '../../../src/storage/db.js';

export const DISCORD_CHAT_ID_BASE = -8_000_000_000_001;
export const DISCORD_CHAT_ID_MIN_BOUND = -8_999_999_999_999;

export function isDiscordChatId(chatId: number): boolean {
  return (
    Number.isFinite(chatId) && chatId <= DISCORD_CHAT_ID_BASE && chatId >= DISCORD_CHAT_ID_MIN_BOUND
  );
}

// Stable 39-bit hash of "<userId>:<channelId>" offset into the negative
// namespace. Deterministic so a pair always resolves to the same Modulus
// chatId across restarts even if the DB row is lost — the row is still the
// canonical record, but a stable hash means lookups never miss because of
// a race on first-write.
function hashedSyntheticId(userId: string, channelId: string): number {
  const h = createHash('sha256').update(`${userId}:${channelId}`).digest();
  // Take the first 5 bytes (40 bits): plenty of room to avoid collisions
  // for any realistic install (~2^20 chats), and stays well inside JS
  // safe-int range.
  const n = h[0]! * 2 ** 32 + h[1]! * 2 ** 24 + h[2]! * 2 ** 16 + h[3]! * 2 ** 8 + h[4]!;
  // Modulo 9e11 keeps us inside the [BASE, MIN_BOUND] window after
  // subtraction. The window is 1e12 wide, so 9e11 leaves a comfortable
  // margin against rounding artefacts at the boundaries.
  const offset = n % 900_000_000_000;
  return DISCORD_CHAT_ID_BASE - offset;
}

export interface DiscordChatRow {
  modulusChatId: number;
  discordUserId: string;
  discordChannelId: string;
  isDm: boolean;
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface IdentityStore {
  // Resolve or create the synthetic Modulus chatId for a Discord pair.
  // Updates last_seen_at on every call.
  chatIdFor(opts: { userId: string; channelId: string; isDm: boolean }): number;
  // Look up the Discord pair behind a synthetic chatId. Returns null when
  // the chatId is unknown (e.g. a Telegram id, or a row that was deleted).
  resolve(chatId: number): DiscordChatRow | null;
  // Count of known chats — used by /discord status and tests.
  count(): number;
}

export function createIdentityStore(db: DB): IdentityStore {
  const selectByPair = db.prepare(
    `SELECT modulus_chat_id, discord_user_id, discord_channel_id, is_dm,
            first_seen_at, last_seen_at
       FROM discord_chats
      WHERE discord_user_id = ? AND discord_channel_id = ?`,
  );
  const selectByChatId = db.prepare(
    `SELECT modulus_chat_id, discord_user_id, discord_channel_id, is_dm,
            first_seen_at, last_seen_at
       FROM discord_chats
      WHERE modulus_chat_id = ?`,
  );
  const selectByChatIdOnly = db.prepare(
    `SELECT modulus_chat_id FROM discord_chats WHERE modulus_chat_id = ?`,
  );
  const insert = db.prepare(
    `INSERT INTO discord_chats
       (modulus_chat_id, discord_user_id, discord_channel_id, is_dm,
        first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const touch = db.prepare(`UPDATE discord_chats SET last_seen_at = ? WHERE modulus_chat_id = ?`);
  const countAll = db.prepare(`SELECT COUNT(*) AS n FROM discord_chats`);

  function rowToRecord(r: {
    modulus_chat_id: number;
    discord_user_id: string;
    discord_channel_id: string;
    is_dm: number;
    first_seen_at: number;
    last_seen_at: number;
  }): DiscordChatRow {
    return {
      modulusChatId: r.modulus_chat_id,
      discordUserId: r.discord_user_id,
      discordChannelId: r.discord_channel_id,
      isDm: r.is_dm !== 0,
      firstSeenAt: r.first_seen_at,
      lastSeenAt: r.last_seen_at,
    };
  }

  return {
    chatIdFor({ userId, channelId, isDm }): number {
      const existing = selectByPair.get(userId, channelId) as
        | {
            modulus_chat_id: number;
            discord_user_id: string;
            discord_channel_id: string;
            is_dm: number;
            first_seen_at: number;
            last_seen_at: number;
          }
        | undefined;
      const now = Date.now();
      if (existing) {
        touch.run(now, existing.modulus_chat_id);
        return existing.modulus_chat_id;
      }

      // Resolve a free synthetic id. The hash is deterministic, so a
      // collision means two different pairs hashed to the same bucket — rare
      // but not impossible. Linear-probe downwards until we find a free row.
      let candidate = hashedSyntheticId(userId, channelId);
      // Cap probes so a pathological collision storm can't loop forever;
      // 64 probes is far more than any realistic install will ever need.
      for (let i = 0; i < 64; i++) {
        const taken = selectByChatIdOnly.get(candidate);
        if (!taken) break;
        candidate -= 1;
        if (candidate < DISCORD_CHAT_ID_MIN_BOUND) {
          throw new Error(
            'modulus-discord: ran out of synthetic chat-id space (BASE..MIN_BOUND exhausted)',
          );
        }
      }

      insert.run(candidate, userId, channelId, isDm ? 1 : 0, now, now);
      return candidate;
    },
    resolve(chatId): DiscordChatRow | null {
      if (!isDiscordChatId(chatId)) return null;
      const row = selectByChatId.get(chatId) as
        | {
            modulus_chat_id: number;
            discord_user_id: string;
            discord_channel_id: string;
            is_dm: number;
            first_seen_at: number;
            last_seen_at: number;
          }
        | undefined;
      return row ? rowToRecord(row) : null;
    },
    count(): number {
      const r = countAll.get() as { n: number };
      return r.n;
    },
  };
}
