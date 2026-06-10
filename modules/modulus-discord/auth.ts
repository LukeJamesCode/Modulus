// `modulus auth modulus-discord` — paste a Discord bot token.
//
// We never accept the token via env or config.json — the task brief calls
// that out explicitly. Settings storage is plaintext SQLite (see
// makeSettings in src/core/modules.ts), masked in the TUI by virtue of
// the `secret: true` flag in settings.schema.json. There is no `host.secrets`
// surface in v1, so this is the same pattern modulus-codex uses for OAuth
// tokens.

import type { Host } from '../../src/core/modules.js';

// Bot tokens are documented as ~70 chars. We don't try to fully validate
// the format (Discord doesn't promise stability), but we reject anything
// suspiciously short so a paste error fails loud rather than silently.
const MIN_TOKEN_LENGTH = 40;

export function register(host: Host): void {
  host.auth.flow({
    label: 'Discord bot token (paste from the Developer Portal)',
    run: async (io) => {
      io.print(
        'Authorize Modulus to act as a Discord bot.\n\n' +
          'How to obtain a token:\n' +
          '  1. Open https://discord.com/developers/applications\n' +
          '  2. Create a new application (or open an existing one).\n' +
          '  3. In the sidebar, choose Bot.\n' +
          '  4. Click "Reset Token" (or "Add Bot" on a new app) and copy the value.\n' +
          '  5. Enable "Message Content Intent" on the Bot page so DMs/mentions reach Modulus.\n' +
          '  6. Use the OAuth2 URL Generator to invite the bot — see the extension README.\n',
      );

      const token = (await io.prompt('Paste the bot token:', { secret: true })).trim();
      if (token.length < MIN_TOKEN_LENGTH) {
        throw new Error(
          `That doesn't look like a Discord bot token (${token.length} chars). ` +
            'A token is typically 70+ chars; re-run `modulus auth modulus-discord` once you have it.',
        );
      }
      // We don't probe the gateway here — auth flows run synchronously from
      // the CLI and a gateway login takes a couple seconds. The jobs.ts
      // entrypoint will exercise the token on next `modulus start`.
      io.print('  ✓ Token captured. Run `modulus start` (or restart) to bring the bridge online.');
      return { bot_token: token };
    },
  });
}
