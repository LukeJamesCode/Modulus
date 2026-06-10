// Long-running gateway connection. The Discord client lives for as long as
// the Modulus process does; this entrypoint owns the lifecycle and wires
// everything in lib/ together.
//
// On register():
//   * Read the bot token from settings. No token → log and return; the
//     extension is "installed but not configured" until `modulus auth
//     modulus-discord` runs.
//   * Build the identity store, allowlist accessor, bridge, confirm
//     renderer, and client wrapper (uses late-bound getters so we can
//     compose in any order without a circular dep).
//   * Register the chat surface with host.chat so the core router can
//     dispatch confirm-tier prompts to our buttons.
//   * Begin the gateway connection (do not await — login takes a few
//     seconds and we don't want to block other extensions' load).
//
// On unregister(): stop the client. In-flight confirm prompts then resolve
// false (their AbortSignals fire via the orchestrator's per-turn signals).

import type { Host } from '../../src/core/modules.js';
import { createIdentityStore, isDiscordChatId } from './lib/identity.js';
import { createBridge, createRateLimiter, splitForDiscord, type Bridge } from './lib/bridge.js';
import { parseCsvSet, type AllowlistConfig } from './lib/allowlist.js';
import { createConfirmRenderer, type ConfirmRenderer } from './lib/confirm.js';
import { createDiscordClient, type SlashCommandSpec } from './lib/client.js';
import { VoiceManager } from './lib/voice.js';

let stop: (() => Promise<void>) | null = null;

export async function register(host: Host): Promise<void> {
  const log = host.log.child({ mod: 'modulus-discord' });
  // If a prior gateway client is still live — e.g. a hot-reload that re-ran
  // register() before unregister() tore the old one down — stop it first.
  // Two simultaneous connections on the same token make Discord deliver every
  // message twice, so the bot replies twice. This makes register() idempotent.
  if (stop) await stop();
  const token = host.settings.get<string>('bot_token', '');
  if (!token) {
    log.info(
      'modulus-discord installed but no bot_token set — run `modulus auth modulus-discord` to bring the bridge up',
    );
    return;
  }
  if (!host.orchestrator) {
    log.warn('host.orchestrator unavailable — modulus-discord bridge not started');
    return;
  }

  const identity = createIdentityStore(host.db);
  const ratePerMinute = Number(host.settings.get<number>('rate_limit_per_minute', 10)) || 10;
  const rateLimiter = createRateLimiter(ratePerMinute);

  // Identity mode: 0 = isolated synthetic chatId per DM; non-zero shares the
  // given Telegram chat thread for DMs so the two surfaces are one conversation.
  const sharedTelegramChatId = (): number =>
    Number(host.settings.get<number>('shared_telegram_chat_id', 0)) || 0;
  // Where proactive briefings/nudges land on Discord: the configured user, else
  // the first allowlisted DM user.
  const resolveProactiveDmUserId = (): string | null => {
    const explicit = String(host.settings.get<string>('proactive_dm_user_id', '')).trim();
    if (explicit) return explicit;
    for (const id of parseCsvSet(host.settings.get<string>('allowed_dm_user_ids', ''))) return id;
    return null;
  };

  // Forward refs for composition. The client wraps discord.js and needs a
  // bridge + a confirm-button handler; the bridge needs the client's
  // outbound transport; the confirm renderer needs the client's
  // sendPrompt/editPrompt. We tie the knot with let-slots populated below.
  let bridgeRef: Bridge | null = null;
  let confirmRef: ConfirmRenderer | null = null;
  let botUserId = '';
  let voiceManager: VoiceManager | null = null;

  // Allowlist is read on every inbound message so a `modulus config` edit
  // takes effect without restarting the bridge.
  const allowlistAccessor = (): AllowlistConfig => ({
    allowedDmUserIds: parseCsvSet(host.settings.get<string>('allowed_dm_user_ids', '')),
    botUserId,
  });

  const client = createDiscordClient({
    token,
    log,
    bridge: () => bridgeRef,
    allowlist: allowlistAccessor,
    handleConfirmButton: (customId, by) => (confirmRef ? confirmRef.onButton(customId, by) : false),
    handleVoiceStateUpdate: (ctx) => {
      voiceManager?.handleVoiceStateUpdate(
        ctx.userId,
        ctx.oldChannelId,
        ctx.newChannelId,
        ctx.guildId,
      );
    },
  });

  voiceManager = new VoiceManager({
    log,
    allowlist: allowlistAccessor,
    host,
    bridge: () => bridgeRef,
  });

  // Patch the resolveChat half of the confirm transport now that the
  // identity store exists. The send/edit halves are already wired to
  // discord.js inside client.ts.
  client.confirmTransport.resolveChat = (chatId) => identity.resolve(chatId);

  confirmRef = createConfirmRenderer({
    transport: client.confirmTransport,
    log,
  });

  bridgeRef = createBridge({
    dispatch: host.chat.dispatchInbound,
    identity,
    transport: client.outbound,
    rateLimiter,
    log,
    sharedTelegramChatId,
    // The bot's own id isn't known until `ready` fires; the bridge reads
    // this via the captured reference below. Pass an empty string here
    // (treated as "no mention to strip") so the initial value is harmless;
    // we update botUserId on ready and stripBotMention closes over the
    // module's local — but `botUserId` is a primitive, so it gets copied.
    // To keep the strip live, we provide it via a getter through the bot
    // id string at construction time and re-create the bridge on ready.
    botUserId: '',
  });

  // Register the chat surface with core so confirm-tier tools targeting a
  // Discord chatId pop our buttons instead of routing back to Telegram.
  host.chat.registerConfirm({
    ownsChat: (chatId) => isDiscordChatId(chatId),
    confirm: (req) => confirmRef!.handle(req),
    // Mirror proactive briefings/nudges/reminders to Discord. Core fans these
    // out to every surface (Telegram + here) so the user gets them wherever
    // they are. We DM the configured/allowlisted user; split for the 2000-char
    // cap. Best-effort — core swallows and logs any throw.
    deliverProactive: async (nudge) => {
      const userId = resolveProactiveDmUserId();
      if (!userId || !client.outbound.sendDM) return;
      const text = nudge.text.trim();
      if (!text) return;
      for (const part of splitForDiscord(text)) {
        await client.outbound.sendDM(userId, part);
      }
    },
  });

  // Tiny opt-in slash surface. Task brief: only /modulus enable / disable,
  // and even those go through the host operator. Here we expose a single
  // /modulus command that explains current state — the actual allow/deny
  // edits happen via `modulus config modulus-discord` on the host (terminal,
  // human present), matching the "no model-driven allowlist edits" rule.
  const slashCommands: SlashCommandSpec[] = [
    {
      name: 'modulus',
      description: 'Check whether this channel is opted into Modulus',
      handle: async (ctx) => {
        if (ctx.guildId === null) {
          await ctx.replyEphemeral(
            'I respond in DMs only when your Discord user id is on the allowlist. ' +
              'Ask the bridge operator to add it via `modulus config modulus-discord`.',
          );
          return;
        }
        const allowed = parseCsvSet(host.settings.get<string>('allowed_dm_user_ids', ''));
        const self = client.selfId() ?? 'me';
        if (allowed.has(ctx.userId)) {
          await ctx.replyEphemeral(
            `You are on the allowlist. Mention <@${self}> to chat anywhere!`,
          );
        } else {
          await ctx.replyEphemeral(
            "You aren't on the allowlist. Ask the bridge operator to add " +
              `your user ID (\`${ctx.userId}\`) to allowed_dm_user_ids via \`modulus config modulus-discord\` on the host.`,
          );
        }
      },
    },
    {
      name: 'vcjoin',
      description: 'Summon Modulus into your current voice channel',
      handle: async (ctx) => {
        if (!ctx.guildId) {
          await ctx.replyEphemeral('This command only works in a server.');
          return;
        }
        const vcId = ctx.getMemberVoiceChannelId?.();
        if (!vcId) {
          await ctx.replyEphemeral('You must be in a voice channel first.');
          return;
        }
        const adapter = ctx.getVoiceAdapterCreator?.();
        if (!adapter) {
          await ctx.replyEphemeral('Could not get voice adapter.');
          return;
        }
        await ctx.replyEphemeral('Joining voice channel...');
        await voiceManager?.joinVoiceChannel(ctx.guildId, vcId, adapter);
      },
    },
    {
      name: 'vcleave',
      description: 'Dismiss Modulus from the voice channel',
      handle: async (ctx) => {
        if (!ctx.guildId) return;
        await ctx.replyEphemeral('Leaving voice channel...');
        voiceManager?.leaveVoiceChannel(ctx.guildId);
      },
    },
  ];
  client.registerSlashCommands(slashCommands);

  host.telegram.afterReply(async (ctx) => {
    if (isDiscordChatId(ctx.chatId)) {
      const resolved = identity.resolve(ctx.chatId);
      if (resolved && resolved.discordChannelId) {
        await voiceManager?.playAudio(resolved.discordChannelId, ctx.text);
      }
    }
  });

  // Start the gateway. Don't await — login takes a few seconds and other
  // extensions are still loading. Once `ready` fires we patch in the bot's
  // own user id; messages arriving before then are gated out by the
  // mention-required rule (empty botUserId means no message can match).
  void client.start().then(
    () => {
      botUserId = client.selfId() ?? '';
      // Re-build the bridge with the now-known bot id so stripBotMention
      // works for guild mentions. Lighter-weight than re-constructing the
      // client; nothing closes over `bridgeRef` directly except the
      // client's getter above, which sees the new reference next inbound.
      bridgeRef = createBridge({
        dispatch: host.chat.dispatchInbound,
        identity,
        transport: client.outbound,
        rateLimiter,
        log,
        sharedTelegramChatId,
        botUserId,
      });
      log.info('modulus-discord bridge online', {
        botUserId,
        dmAllowlistSize: parseCsvSet(host.settings.get<string>('allowed_dm_user_ids', '')).size,
      });
    },
    (e) => {
      log.warn('discord gateway login failed', {
        error: e instanceof Error ? e.message : String(e),
      });
    },
  );

  stop = async () => {
    await client.stop();
    stop = null;
  };
}

export async function unregister(_host: Host): Promise<void> {
  if (stop) {
    await stop();
  }
}
