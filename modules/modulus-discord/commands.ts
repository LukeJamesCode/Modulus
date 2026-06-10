// `/discord` — Telegram command that reports bridge status.
//
// The status lives in this extension's SQLite (discord_chats table). We
// don't need the live gateway state to answer "how many chats have I
// talked to over Discord" — the table is the source of truth for what
// the bridge has seen.

import type { Host } from '../../src/core/modules.js';
import { createIdentityStore } from './lib/identity.js';
import { parseCsvSet } from './lib/allowlist.js';

export function register(host: Host): void {
  host.telegram.command(
    'discord',
    async (ctx) => {
      const identity = createIdentityStore(host.db);
      const dmAllow = parseCsvSet(host.settings.get<string>('allowed_dm_user_ids', ''));
      const tokenSet = (host.settings.get<string>('bot_token', '') || '').length > 0;
      const chats = identity.count();
      const lines = [
        `Discord bridge: ${tokenSet ? 'configured' : 'NOT configured (run `modulus auth modulus-discord`)'}`,
        `User allowlist: ${dmAllow.size} user${dmAllow.size === 1 ? '' : 's'}`,
        `Known chats: ${chats}`,
      ];
      await ctx.reply(lines.join('\n'));
    },
    'Show Discord bridge status (linked chats, last seen)',
  );
}
