// Inbound-message gating for modulus-discord. Decisions live here so the
// Discord client wrapper stays a thin transport.
//
// Rules:
//   * DMs are allowed only when the sender's user id is in
//     `allowed_dm_user_ids`. Empty list = no DM access.
//   * Guild channels respond only to @-mentions of the bot, and only when the
//     mentioning user is also in `allowed_dm_user_ids` — the same user
//     allowlist gates every surface, so the bot never answers a stranger even
//     in an opted-in guild.
//   * Bot messages and webhook messages are always ignored.
//
// Returns a structured decision so the caller can log why something was
// dropped (without leaking message content to logs).

export interface AllowlistConfig {
  allowedDmUserIds: Set<string>;
  botUserId: string;
}

export type AllowDecision =
  | { allow: true; kind: 'dm' | 'mention' }
  | { allow: false; reason: AllowDenialReason };

export type AllowDenialReason =
  | 'is_bot'
  | 'is_webhook'
  | 'dm_not_allowed'
  | 'guild_not_mentioned'
  | 'self_message';

export interface InboundMessageMeta {
  authorId: string;
  authorIsBot: boolean;
  isWebhook: boolean;
  channelId: string;
  guildId: string | null;
  // The ids of users explicitly @-mentioned in the message. Required for
  // mention detection in guild channels — content-string regex would be
  // wrong (a stale @everyone, an embedded mention, etc.).
  mentionedUserIds: ReadonlySet<string>;
}

export function decide(cfg: AllowlistConfig, m: InboundMessageMeta): AllowDecision {
  if (m.authorIsBot) return { allow: false, reason: 'is_bot' };
  if (m.isWebhook) return { allow: false, reason: 'is_webhook' };
  if (m.authorId === cfg.botUserId) return { allow: false, reason: 'self_message' };

  const isDm = m.guildId === null;
  if (isDm) {
    if (cfg.allowedDmUserIds.has(m.authorId)) return { allow: true, kind: 'dm' };
    return { allow: false, reason: 'dm_not_allowed' };
  }

  // Guild channel: require an explicit @-mention of the bot.
  if (!m.mentionedUserIds.has(cfg.botUserId)) {
    return { allow: false, reason: 'guild_not_mentioned' };
  }

  // The same user allowlist gates guild mentions as DMs — a mention from a
  // non-allowlisted user is dropped even in a channel the bot can see.
  if (!cfg.allowedDmUserIds.has(m.authorId)) {
    return { allow: false, reason: 'dm_not_allowed' };
  }

  return { allow: true, kind: 'mention' };
}

// Parses a comma-separated settings value into a Set, ignoring whitespace
// and empty fragments. Both allowlist settings are stored as plain CSV in
// the SQLite settings table; this is the single normaliser.
export function parseCsvSet(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}
