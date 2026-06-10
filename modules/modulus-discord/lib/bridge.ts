// Inbound→orchestrator→outbound glue.
//
// For every inbound Discord message that survives the allowlist gate, we:
//   1. Resolve the (user, channel) pair to a synthetic Modulus chatId.
//   2. Strip the bot @-mention so the model sees a clean user message.
//   3. Push the text into host.orchestrator.handleUserMessage with a
//      streaming sink that buffers deltas and ships a single reply on done.
//
// Why buffer-then-send: Discord rate-limits message edits aggressively
// (5/5s per channel typical); a token-by-token editMessage stream is the
// fastest way to draw a hard 429. This mirrors what the Telegram adapter
// does — one send on done — and avoids burning the rate budget on partials.
//
// Multi-part splitting: Discord's per-message cap is 2000 chars. We split
// on paragraph boundaries when possible, then on hard length otherwise.

import type { Logger } from '../../../src/util/log.js';
import type { InboundMessage } from '../../../src/core/chat-dispatch.js';
import type { IdentityStore } from './identity.js';

export const DISCORD_MESSAGE_MAX = 2_000;

// Cheap per-user token bucket. Defends against an allowlisted user
// (or compromised account) hammering the bot into a model burn.
export interface RateLimiter {
  // Returns true if the call is allowed; false if the user is over budget
  // for this minute. Side effect: increments the counter on allow.
  consume(userId: string): boolean;
}

export function createRateLimiter(perMinute: number): RateLimiter {
  if (perMinute <= 0) {
    return { consume: () => true };
  }
  const windowMs = 60_000;
  const seen = new Map<string, { count: number; resetAt: number }>();
  return {
    consume(userId): boolean {
      const now = Date.now();
      const entry = seen.get(userId);
      if (!entry || entry.resetAt <= now) {
        seen.set(userId, { count: 1, resetAt: now + windowMs });
        return true;
      }
      if (entry.count >= perMinute) return false;
      entry.count += 1;
      return true;
    },
  };
}

export interface OutboundTransport {
  // Send a fresh message to the given Discord channel. Resolves once
  // Discord has accepted the send (best-effort — the caller swallows
  // errors and logs).
  send: (channelId: string, text: string) => Promise<void>;
  // Mark the channel as "typing" while a long reply is being produced.
  // No-op on failure.
  startTyping?: (channelId: string) => Promise<void>;
  // Direct-message a Discord user (proactive briefings/nudges). Opens the DM
  // channel as needed. Throws if the user can't be resolved or DMed.
  sendDM?: (userId: string, text: string) => Promise<void>;
}

export interface BridgeOptions {
  // Runs the inbound turn through the shared host pipeline — extension
  // commands, message intercepts, the orchestrator turn, and the
  // afterReply/afterTurn hooks. This is host.chat.dispatchInbound, so Discord
  // gets the exact same surface behaviour Telegram does, not just raw model
  // turns. Replies arrive via the `reply` callback we pass per turn.
  dispatch: (msg: InboundMessage) => Promise<void>;
  identity: IdentityStore;
  transport: OutboundTransport;
  rateLimiter: RateLimiter;
  log: Logger;
  // The bot's own Discord user id. Used to strip the leading @-mention so
  // the pipeline doesn't see "<@123456789> hi" as the user message.
  botUserId: string;
  // Identity mode. When this returns a non-zero Telegram chat id, DMs are
  // mapped onto it so Discord and Telegram share a single conversation thread
  // (same history). Zero (default) keeps DMs on an isolated synthetic chatId.
  // Only DMs are shared — a guild channel can't merge into a personal thread.
  sharedTelegramChatId?: () => number;
}

export interface InboundTurn {
  userId: string;
  channelId: string;
  guildId: string | null;
  rawContent: string;
}

export interface Bridge {
  handle(turn: InboundTurn): Promise<void>;
}

// Strip "<@botid>" / "<@!botid>" mentions of the bot from the message.
// Discord renders user mentions as `<@123>`; the `!` variant is the legacy
// nickname-mention form. Multiple leading/trailing mentions are stripped
// so "@modulus @modulus hello" still reads as "hello" to the model.
export function stripBotMention(content: string, botUserId: string): string {
  const escaped = botUserId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<@!?${escaped}>`, 'g');
  return content.replace(re, '').replace(/\s+/g, ' ').trim();
}

// Split a long string into <=2000-char chunks, preferring paragraph
// boundaries. Falls back to hard slicing for content that has no paragraph
// breaks (e.g. a 3000-char code block).
export function splitForDiscord(text: string, max = DISCORD_MESSAGE_MAX): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let remaining = text;
  while (remaining.length > max) {
    let split = remaining.lastIndexOf('\n\n', max);
    if (split < max / 2) split = remaining.lastIndexOf('\n', max);
    if (split < max / 4) split = max;
    out.push(remaining.slice(0, split).trimEnd());
    remaining = remaining.slice(split).trimStart();
  }
  if (remaining.length > 0) out.push(remaining);
  return out;
}

export function createBridge(opts: BridgeOptions): Bridge {
  return {
    async handle(turn): Promise<void> {
      const text = stripBotMention(turn.rawContent, opts.botUserId);
      if (text.length === 0) {
        // Bare mention with no content — friendly nudge, no LLM round-trip.
        await opts.transport
          .send(turn.channelId, 'Hi — send a message after the mention and I’ll respond.')
          .catch((e) => opts.log.warn('discord empty-mention reply failed', { error: errStr(e) }));
        return;
      }
      if (!opts.rateLimiter.consume(turn.userId)) {
        opts.log.info('discord rate-limited turn', { userId: turn.userId });
        await opts.transport
          .send(
            turn.channelId,
            '⏱ You’re sending messages faster than the per-minute limit. Slow down and try again shortly.',
          )
          .catch(() => {});
        return;
      }

      // Identity: DMs can optionally share the user's Telegram conversation
      // thread; guild channels always use an isolated synthetic chatId (they
      // can't merge into a personal Telegram thread).
      const isDm = turn.guildId === null;
      const sharedId = opts.sharedTelegramChatId?.() ?? 0;
      const modulusChatId =
        isDm && sharedId !== 0
          ? sharedId
          : opts.identity.chatIdFor({
              userId: turn.userId,
              channelId: turn.channelId,
              isDm,
            });

      // Number() the userId for the pipeline's numeric userId. Discord ids
      // exceed MAX_SAFE_INTEGER, but userId is only used by core for logging /
      // attribution; precision loss in the bottom ~10 bits doesn't change any
      // safety behaviour. The full string id is what we keep in the identity
      // table for accurate lookups.
      const userIdNum = Number(turn.userId);

      // Best-effort typing indicator — gives users feedback during the
      // multi-second cold-path. Discord ratelimits typing too, so this is
      // fire-and-forget.
      void opts.transport.startTyping?.(turn.channelId).catch(() => {});

      // Render a reply on this channel. The shared pipeline owns buffering /
      // hallucination-guard replacement and calls this with assembled text
      // (possibly more than once: an intercept ack then the model answer).
      // We only own Discord's 2000-char split.
      const reply = async (t: string): Promise<void> => {
        const final = t.trim();
        if (final.length === 0) return;
        for (const part of splitForDiscord(final)) {
          try {
            await opts.transport.send(turn.channelId, part);
          } catch (e) {
            opts.log.warn('discord outbound send failed', {
              channelId: turn.channelId,
              error: errStr(e),
            });
            break;
          }
        }
      };

      try {
        await opts.dispatch({ chatId: modulusChatId, userId: userIdNum, text, reply });
      } catch (e) {
        opts.log.warn('discord dispatchInbound threw', {
          chatId: modulusChatId,
          error: errStr(e),
        });
        await opts.transport
          .send(
            turn.channelId,
            '⚠ Something went wrong handling that message. Check `modulus status` on the host.',
          )
          .catch(() => {});
      }
    },
  };
}

function errStr(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
