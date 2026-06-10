// Bridges the daemon's confirm-tier tool gate to the browser chat.
//
// When a panel chat turn is streaming, it registers a confirm renderer for its
// chatId here. The daemon's confirmToolCall router (start.ts) consults this bus
// BEFORE its Telegram fallback: if the browser turn is live (A) the prompt
// renders inline there; otherwise (B) it falls through to chat surfaces /
// Telegram. Either way the prompt reaches the owner, and an undelivered or
// unanswered confirm fails closed — nothing risky runs unconfirmed.

import type { ToolContext, ToolHandler } from '../core/tools.js';

export type ConfirmFn = (
  handler: ToolHandler,
  args: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<boolean>;

export interface PanelConfirmBus {
  register(chatId: number, fn: ConfirmFn): void;
  unregister(chatId: number, fn: ConfirmFn): void;
  // A pending confirm for ctx.chatId's registered renderer, or null if none is
  // registered (the caller then falls through to its other surfaces).
  tryConfirm(
    handler: ToolHandler,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<boolean> | null;
}

export function createPanelConfirmBus(): PanelConfirmBus {
  const byChat = new Map<number, ConfirmFn>();
  return {
    register(chatId, fn) {
      byChat.set(chatId, fn);
    },
    unregister(chatId, fn) {
      // Only clear if we still own the slot — a newer turn may have replaced us.
      if (byChat.get(chatId) === fn) byChat.delete(chatId);
    },
    tryConfirm(handler, args, ctx) {
      if (ctx.chatId === undefined) return null;
      const fn = byChat.get(ctx.chatId);
      return fn ? fn(handler, args, ctx) : null;
    },
  };
}
