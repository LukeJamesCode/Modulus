// Confirm-tier renderer for the Discord chat surface.
//
// The core confirm router (src/cli/start.ts) hands us a ChatConfirmRequest
// for any confirm-tier tool whose ctx.chatId belongs to this surface. We
// deliver the prompt as a Discord message with two inline buttons and
// resolve true/false based on which button the user clicks.
//
// Safety properties (must mirror Telegram):
//   * Single-use — the token is removed from the pending map on the first
//     click, and any subsequent click on either button gets ignored.
//   * Time-boxed — a default 60s expiry fires before the orchestrator's
//     own per-tool timeout, so a forgotten prompt is auto-denied.
//   * Abort-aware — when the originating turn's AbortSignal fires (e.g.
//     /stop), we resolve false immediately and edit the prompt to "cancelled".
//   * Fail-closed — if we cannot send the prompt at all (channel deleted,
//     missing permissions, etc.), the promise resolves false so the
//     confirm-tier tool refuses.
//
// The Discord message+button send is injected so this module is fully
// testable without a live Discord gateway connection.

import { randomBytes } from 'node:crypto';
import type { ChatConfirmRequest } from '../../../src/core/modules.js';
import type { Logger } from '../../../src/util/log.js';
import type { DiscordChatRow } from './identity.js';

// 60 seconds, matching the safety doc's confirm-with-diff expiry target.
export const DISCORD_CONFIRM_TIMEOUT_MS = 60_000;

export interface ConfirmMessageRef {
  // Opaque per-renderer message handle. We don't depend on Discord's API
  // surface in this module — `sendPrompt` returns whatever the live client
  // hands back, and `editPrompt` echoes it.
  channelId: string;
  messageId: string;
}

export interface PendingConfirm {
  // The chat the prompt was sent to. Bound at send time so a later click
  // can sanity-check it before resolving.
  chatId: number;
  // Resolver for the awaiting orchestrator. Called exactly once.
  resolve: (ok: boolean, note: string) => void;
}

// Transport adapter — production wires this to the discord.js client; tests
// pass an in-memory stub so they can drive button taps deterministically.
export interface ConfirmTransport {
  // Resolve the (channelId, isDm) for a synthetic Modulus chatId. Used to
  // decide where the prompt should be sent.
  resolveChat: (chatId: number) => DiscordChatRow | null;
  // Send a fresh prompt with two buttons whose custom_id values are
  // `${tokenPrefix}:yes` and `${tokenPrefix}:no`. Returns the message ref
  // so we can edit it once the user picks. Throws on send failure (caller
  // catches and fails closed).
  sendPrompt: (params: {
    channelId: string;
    text: string;
    yesCustomId: string;
    noCustomId: string;
  }) => Promise<ConfirmMessageRef>;
  // Best-effort edit: replace the prompt text and strip the buttons so a
  // stale prompt isn't tappable after expiry/cancel. Failures are swallowed
  // by the caller — the resolver's promise has already settled.
  editPrompt: (ref: ConfirmMessageRef, text: string) => Promise<void>;
}

export interface ConfirmRendererOptions {
  transport: ConfirmTransport;
  log: Logger;
  timeoutMs?: number;
}

export interface ConfirmRenderer {
  // Implementation of ChatSurfaceRegistration.confirm — pass directly to
  // host.chat.registerConfirm.
  handle: (req: ChatConfirmRequest) => Promise<boolean>;
  // Dispatch an inbound button interaction. The Discord client wrapper
  // calls this on every InteractionCreate whose customId starts with the
  // shared confirm prefix. Returns true if the interaction was a known
  // pending confirm (so the caller can ack accordingly).
  onButton: (customId: string, by: { userId: string }) => boolean;
  // Test/diagnostic accessor; number of confirms currently waiting.
  pendingCount: () => number;
}

// All custom_ids share this prefix so the dispatcher can match in O(1)
// without parsing every button. Keep it stable; changing it would orphan
// any in-flight prompts after a hot-reload.
const CUSTOM_ID_PREFIX = 'gd-confirm';

function newToken(): string {
  // 18 hex chars = 72 bits of entropy, well over the birthday-bound for
  // the pending-set size we'll ever see in a single Modulus process.
  return randomBytes(9).toString('hex');
}

export function createConfirmRenderer(opts: ConfirmRendererOptions): ConfirmRenderer {
  const timeoutMs = opts.timeoutMs ?? DISCORD_CONFIRM_TIMEOUT_MS;
  const pending = new Map<string, PendingConfirm>();

  function handle(req: ChatConfirmRequest): Promise<boolean> {
    return new Promise((resolveOuter) => {
      // Fail closed early if the chat isn't known or already aborted.
      const chat = opts.transport.resolveChat(req.chatId);
      if (!chat) {
        opts.log.warn('discord confirm: unknown chatId, failing closed', {
          chatId: req.chatId,
          tool: req.toolName,
        });
        resolveOuter(false);
        return;
      }
      if (req.signal?.aborted) {
        resolveOuter(false);
        return;
      }

      const token = newToken();
      const yesId = `${CUSTOM_ID_PREFIX}:${token}:yes`;
      const noId = `${CUSTOM_ID_PREFIX}:${token}:no`;

      const promptText = req.preview;
      let ref: ConfirmMessageRef | null = null;

      let settled = false;
      const finish = (ok: boolean, note: string): void => {
        if (settled) return;
        settled = true;
        pending.delete(token);
        clearTimeout(timer);
        req.signal?.removeEventListener('abort', onAbort);
        if (ref) {
          // Best-effort edit; never throw out of the resolver.
          void opts.transport.editPrompt(ref, note).catch(() => {});
        }
        resolveOuter(ok);
      };

      const onAbort = (): void => finish(false, `${promptText}\n\n⏹ Cancelled.`);
      const timer: ReturnType<typeof setTimeout> = setTimeout(
        () => finish(false, `${promptText}\n\n⌛ Timed out — not run.`),
        timeoutMs,
      );
      timer.unref?.();
      req.signal?.addEventListener('abort', onAbort, { once: true });

      // Register the pending entry BEFORE awaiting the send so that a
      // button tap arriving on a slow connection can't be dropped because
      // the map doesn't have the token yet. If sendPrompt then throws,
      // we explicitly delete on the failure path.
      pending.set(token, {
        chatId: req.chatId,
        resolve: (ok, note) => finish(ok, note),
      });

      void opts.transport
        .sendPrompt({
          channelId: chat.discordChannelId,
          text: promptText,
          yesCustomId: yesId,
          noCustomId: noId,
        })
        .then((msgRef) => {
          if (settled) {
            // Aborted or timed out while the send was in flight. Edit the
            // freshly-sent message to reflect the actual final state so
            // the user isn't left looking at a dead prompt with buttons.
            void opts.transport
              .editPrompt(msgRef, `${promptText}\n\n⏹ No longer relevant.`)
              .catch(() => {});
            return;
          }
          ref = msgRef;
        })
        .catch((e: unknown) => {
          opts.log.warn('discord confirm: prompt send failed, failing closed', {
            chatId: req.chatId,
            tool: req.toolName,
            error: e instanceof Error ? e.message : String(e),
          });
          finish(false, `${promptText}\n\n⚠ Could not deliver prompt.`);
        });
    });
  }

  function onButton(customId: string, by: { userId: string }): boolean {
    // Parse `gd-confirm:<token>:<yes|no>`. Defensive against custom_ids
    // that happen to start with our prefix but aren't ours.
    if (!customId.startsWith(`${CUSTOM_ID_PREFIX}:`)) return false;
    const rest = customId.slice(CUSTOM_ID_PREFIX.length + 1);
    const sep = rest.lastIndexOf(':');
    if (sep === -1) return false;
    const token = rest.slice(0, sep);
    const choice = rest.slice(sep + 1);
    if (choice !== 'yes' && choice !== 'no') return false;

    const entry = pending.get(token);
    if (!entry) {
      // Stale click on an already-resolved prompt — ignore. The Discord
      // client wrapper still acks the interaction so the user doesn't see
      // a "interaction failed" toast.
      opts.log.debug('discord confirm: stale button click ignored', {
        token,
        userId: by.userId,
      });
      return true;
    }
    // We don't check that the clicker matches the original requester —
    // the allowlist already gates *who* the bot talks to at all, and any
    // allowlisted user is already trusted in the same way Telegram is.
    const ok = choice === 'yes';
    const note = ok ? '✅ Approved — on it.' : '❌ Declined.';
    void by;
    entry.resolve(ok, note);
    return true;
  }

  return {
    handle,
    onButton,
    pendingCount: () => pending.size,
  };
}
