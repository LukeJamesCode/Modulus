// Setup entrypoint for modulus-discord. Runs on enable/install and installs the
// npm packages core deliberately doesn't carry: 'discord.js' (the gateway
// client) and '@discordjs/voice' (voice-channel support; pulls in prism-media).
// The module itself loads without them — jobs.ts only imports the gateway
// libraries once a bot token is configured — but the bridge can't come up
// until both resolve from the module's own node_modules. Best-effort: a failed
// install reports the manual command and does not undo the enable.
//
// Audio playback (the /vcjoin voice feature) additionally needs an encryption
// backend and an opus encoder; those are only touched when you actually join a
// voice channel (not at module load), so they're documented in the README
// rather than auto-installed here — the opus encoder is a native build we don't
// want to trigger on a small device that may never use voice.

import type { ModuleSetupContext } from '../../src/core/modules.js';

// discord.js pin matches what the module is written against; @discordjs/voice's
// 0.18 line is the one compatible with discord.js 14.
const DISCORD_JS_VERSION = '^14.26.4';
const DISCORD_VOICE_VERSION = '^0.18.0';

export async function setup(ctx: ModuleSetupContext): Promise<void> {
  await ctx.ensureNpmDeps([
    { pkg: 'discord.js', version: DISCORD_JS_VERSION },
    { pkg: '@discordjs/voice', version: DISCORD_VOICE_VERSION },
  ]);
}
