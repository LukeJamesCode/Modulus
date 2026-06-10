// Thin discord.js v14 Gateway-WebSocket wrapper. Owns lifecycle (login,
// destroy), event wiring, and the I/O surface the bridge + confirm renderer
// consume. Keeps everything that touches discord.js confined here so the
// rest of the extension can be tested without a live gateway.

import {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Message,
  type Interaction,
  type VoiceState,
} from 'discord.js';
import type { DiscordGatewayAdapterCreator } from '@discordjs/voice';
import type { Logger } from '../../../src/util/log.js';
import type { Bridge } from './bridge.js';
import { decide, type AllowlistConfig, type InboundMessageMeta } from './allowlist.js';
import type { ConfirmTransport, ConfirmMessageRef } from './confirm.js';
import type { OutboundTransport } from './bridge.js';

export interface DiscordClientHandle {
  // Begin the gateway connection. Resolves once `ready` fires (or rejects
  // on login failure).
  start: () => Promise<void>;
  // Tear the connection down. Safe to call multiple times.
  stop: () => Promise<void>;
  // The bot's own Discord user id, populated once login completes. null
  // before `ready`; callers should defer reads that need it.
  selfId: () => string | null;
  // I/O surfaces that other modules consume. Wired against the live
  // client; never reach back into discord.js elsewhere.
  outbound: OutboundTransport;
  confirmTransport: ConfirmTransport;
  // Slash-command registrar — wires global commands once on `ready`.
  registerSlashCommands: (cmds: SlashCommandSpec[]) => void;
}

export interface SlashCommandSpec {
  name: string;
  description: string;
  // Handler receives normalised slash-command context. The current scope
  // is intentionally tiny (`/modulus enable`/`disable`) so we don't expose
  // discord.js's full Interaction surface to callers.
  handle: (ctx: SlashCommandContext) => Promise<void>;
}

export interface SlashCommandContext {
  guildId: string | null;
  channelId: string;
  userId: string;
  getVoiceAdapterCreator?: () => DiscordGatewayAdapterCreator | undefined;
  getMemberVoiceChannelId?: () => string | null;
  // Reply privately (ephemeral) so opt-in/opt-out chatter doesn't spam
  // the channel for other members.
  replyEphemeral: (text: string) => Promise<void>;
}

export interface DiscordClientOptions {
  token: string;
  log: Logger;
  // Bridge accessor. Returning null means "not ready yet" — inbound
  // messages before composition completes are dropped to avoid a partially
  // initialised pipeline. A getter rather than a value lets jobs.ts compose
  // the bridge and the client without a circular constructor dependency.
  bridge: () => Bridge | null;
  allowlist: () => AllowlistConfig;
  // Receives every interaction whose customId starts with the confirm
  // renderer's prefix. Returns true if claimed; false otherwise. Late-bound
  // for the same reason as `bridge`.
  handleConfirmButton: (customId: string, by: { userId: string }) => boolean;
  // Build the client only after these intents are present. Tests pass an
  // override; production uses the default factory.
  clientFactory?: () => Client;
  handleVoiceStateUpdate?: (ctx: {
    userId: string;
    oldChannelId: string | null;
    newChannelId: string | null;
    guildId: string;
  }) => void;
}

const DEFAULT_INTENTS: GatewayIntentBits[] = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.DirectMessages,
  GatewayIntentBits.MessageContent,
  GatewayIntentBits.GuildVoiceStates,
];

function defaultClient(): Client {
  return new Client({
    intents: DEFAULT_INTENTS,
    partials: [Partials.Channel],
  });
}

// Process-wide exactly-once guard for inbound messages. discord.js delivers
// each message once per gateway connection, so seeing the same id twice means
// a second connection is live in this process (e.g. a hot-reload that re-ran
// register() before the previous client finished tearing down). Deduping by id
// here — module-level so it's shared across any client instances in the
// process — makes the bot reply exactly once. (Two separate Modulus processes
// share no memory and can't be deduped here; that's an operator issue.)
const HANDLED_MESSAGE_CAP = 500;
const handledMessageIds = new Set<string>();
const handledMessageOrder: string[] = [];
function markMessageHandled(id: string): boolean {
  if (handledMessageIds.has(id)) return true;
  handledMessageIds.add(id);
  handledMessageOrder.push(id);
  if (handledMessageOrder.length > HANDLED_MESSAGE_CAP) {
    const evicted = handledMessageOrder.shift();
    if (evicted !== undefined) handledMessageIds.delete(evicted);
  }
  return false;
}

export function createDiscordClient(opts: DiscordClientOptions): DiscordClientHandle {
  const client = (opts.clientFactory ?? defaultClient)();
  const log = opts.log.child({ mod: 'discord-client' });
  const slashCommands = new Map<string, SlashCommandSpec>();
  let started = false;
  let stopped = false;
  let readyResolve: (() => void) | null = null;
  let readyReject: ((e: unknown) => void) | null = null;
  const readyPromise = new Promise<void>((res, rej) => {
    readyResolve = res;
    readyReject = rej;
  });

  client.on('ready', () => {
    log.info('discord gateway ready', { user: client.user?.tag, id: client.user?.id });
    // Push registered slash commands now that the application is known.
    void registerCommandsWithApi();
    readyResolve?.();
  });
  client.on('error', (e) => {
    log.warn('discord client error', { error: e instanceof Error ? e.message : String(e) });
  });

  client.on('messageCreate', (msg: Message) => {
    handleMessage(msg).catch((e) =>
      log.warn('discord messageCreate handler failed', {
        error: e instanceof Error ? e.message : String(e),
      }),
    );
  });

  client.on('interactionCreate', (interaction: Interaction) => {
    handleInteraction(interaction).catch((e) =>
      log.warn('discord interactionCreate handler failed', {
        error: e instanceof Error ? e.message : String(e),
      }),
    );
  });

  client.on('voiceStateUpdate', (oldState: VoiceState, newState: VoiceState) => {
    if (opts.handleVoiceStateUpdate) {
      const userId = newState.member?.id || newState.id;
      if (userId) {
        opts.handleVoiceStateUpdate({
          userId,
          oldChannelId: oldState.channelId,
          newChannelId: newState.channelId,
          guildId: newState.guild.id,
        });
      }
    }
  });

  async function handleMessage(msg: Message): Promise<void> {
    // Exactly-once guard — see markMessageHandled. Drops a message a second
    // gateway connection (e.g. from a reload race) would otherwise re-deliver.
    if (markMessageHandled(msg.id)) {
      log.debug('discord duplicate messageCreate ignored', { id: msg.id });
      return;
    }
    // Build a transport-neutral meta so the gating logic stays unit-testable.
    const meta: InboundMessageMeta = {
      authorId: msg.author.id,
      authorIsBot: msg.author.bot,
      isWebhook: msg.webhookId !== null,
      channelId: msg.channelId,
      guildId: msg.guildId,
      mentionedUserIds: new Set(msg.mentions.users.map((u) => u.id)),
    };
    const decision = decide(opts.allowlist(), meta);
    if (!decision.allow) {
      // Drop with a debug-level log; this is the common case and we don't
      // want to spam warn for every channel post in an opted-in guild.
      log.debug('discord message dropped', {
        reason: decision.reason,
        guildId: meta.guildId,
        channelId: meta.channelId,
      });
      return;
    }
    const bridge = opts.bridge();
    if (!bridge) {
      log.debug('discord message arrived before bridge ready, dropping');
      return;
    }
    await bridge.handle({
      userId: msg.author.id,
      channelId: msg.channelId,
      guildId: msg.guildId,
      rawContent: msg.content,
    });
  }

  async function handleInteraction(interaction: Interaction): Promise<void> {
    if (interaction.isButton()) {
      const claimed = opts.handleConfirmButton(interaction.customId, {
        userId: interaction.user.id,
      });
      if (claimed) {
        // Ack so Discord doesn't show "interaction failed". The renderer
        // edits the message text + buttons asynchronously via the
        // confirmTransport.editPrompt path.
        try {
          await interaction.deferUpdate();
        } catch (e) {
          log.debug('discord deferUpdate failed', {
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      return;
    }
    if (interaction.isChatInputCommand()) {
      const spec = slashCommands.get(interaction.commandName);
      if (!spec) return;
      const ctx: SlashCommandContext = {
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        userId: interaction.user.id,
        getVoiceAdapterCreator: () => interaction.guild?.voiceAdapterCreator,
        getMemberVoiceChannelId: () => {
          const member = interaction.member;
          return member && 'voice' in member && member.voice.channelId
            ? member.voice.channelId
            : null;
        },
        replyEphemeral: async (text) => {
          try {
            await interaction.reply({ content: text, flags: 64 });
          } catch (e) {
            log.warn('discord slash reply failed', {
              cmd: spec.name,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        },
      };
      try {
        await spec.handle(ctx);
      } catch (e) {
        log.warn('discord slash handler threw', {
          cmd: spec.name,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  async function registerCommandsWithApi(): Promise<void> {
    if (slashCommands.size === 0) return;
    if (!client.application) return;
    try {
      await client.application.commands.set(
        [...slashCommands.values()].map((c) => ({
          name: c.name,
          description: c.description,
        })),
      );
      log.info('discord slash commands registered', {
        count: slashCommands.size,
      });
    } catch (e) {
      log.warn('discord slash registration failed', {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const outbound: OutboundTransport = {
    send: async (channelId, text) => {
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel || !channel.isTextBased() || !('send' in channel)) {
        throw new Error(`channel ${channelId} is not sendable`);
      }
      await (channel as { send: (msg: string) => Promise<unknown> }).send(text);
    },
    startTyping: async (channelId) => {
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel || !channel.isTextBased() || !('sendTyping' in channel)) return;
      await (channel as { sendTyping: () => Promise<unknown> }).sendTyping();
    },
    sendDM: async (userId, text) => {
      // Resolve the user and send to their DM channel (discord.js opens it as
      // needed). Used by the proactive mirror — the user must share a guild
      // with the bot or have DMs open, else Discord rejects the send.
      const user = await client.users.fetch(userId).catch(() => null);
      if (!user) throw new Error(`discord user ${userId} not found`);
      await user.send(text);
    },
  };

  // The send/edit halves of the confirm transport belong to discord.js
  // (they call channel.send / message.edit). The resolveChat half is owned
  // by the identity store, which jobs.ts patches in after composition.
  // Defaulting it to a null-returner means a stray send before composition
  // safely fails closed rather than throwing.
  const confirmTransport: ConfirmTransport = {
    resolveChat: () => null,
    sendPrompt: async ({
      channelId,
      text,
      yesCustomId,
      noCustomId,
    }): Promise<ConfirmMessageRef> => {
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel || !channel.isTextBased() || !('send' in channel)) {
        throw new Error(`confirm channel ${channelId} is not sendable`);
      }
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(yesCustomId)
          .setLabel('✓ Confirm')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(noCustomId)
          .setLabel('✗ Cancel')
          .setStyle(ButtonStyle.Secondary),
      );
      const sent = (await (
        channel as {
          send: (msg: {
            content: string;
            components: Array<ActionRowBuilder<ButtonBuilder>>;
          }) => Promise<{ id: string; channelId: string }>;
        }
      ).send({ content: text, components: [row] })) as { id: string; channelId: string };
      return { channelId: sent.channelId, messageId: sent.id };
    },
    editPrompt: async (ref, text) => {
      const channel = await client.channels.fetch(ref.channelId).catch(() => null);
      if (!channel || !channel.isTextBased()) return;
      const message = await (
        channel as { messages: { fetch: (id: string) => Promise<Message> } }
      ).messages
        .fetch(ref.messageId)
        .catch(() => null);
      if (!message) return;
      // Strip components so the buttons are no longer tappable.
      await message.edit({ content: text, components: [] }).catch(() => {});
    },
  };

  async function start(): Promise<void> {
    if (started) return readyPromise;
    started = true;
    try {
      await client.login(opts.token);
    } catch (e) {
      stopped = true;
      readyReject?.(e);
      throw e;
    }
    return readyPromise;
  }

  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;
    try {
      await client.destroy();
    } catch (e) {
      log.warn('discord client destroy failed', {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return {
    start,
    stop,
    selfId: () => client.user?.id ?? null,
    outbound,
    confirmTransport,
    registerSlashCommands: (cmds) => {
      for (const c of cmds) slashCommands.set(c.name, c);
    },
  };
}
