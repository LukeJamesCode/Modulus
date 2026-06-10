// Telegram slash commands for modulus-codex.
//
//   /codex <task>   — explicit, user-initiated handoff. Because the user typed
//                     it, this is unambiguous consent: the raw Codex output is
//                     sent straight back (truncated to Telegram's limit) rather
//                     than summarised.
//   /codexstatus    — today's usage against the daily ceiling.
//   /codexlogout    — forget stored credentials.

import type { Host } from '../../src/core/modules.js';
import { runHandoff, readSettings } from './lib/run.js';
import { localDay, usageToday } from './lib/budget.js';
import { readTokens, clearTokens } from './lib/store.js';
import { conversationIdForChat } from './lib/history.js';

// Telegram hard-caps a message at 4096 chars. Command replies are sent straight
// to grammY (the orchestrator's chunked send path isn't on this route), so a
// long Codex answer would be rejected and silently dropped. Split it into
// multiple messages on natural boundaries instead of truncating.
const TELEGRAM_LIMIT = 4000;

export function splitForTelegram(text: string, limit = TELEGRAM_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    // Prefer to break at a paragraph, then a line, then a space — but only in
    // the back half so chunks stay reasonably full.
    let cut = window.lastIndexOf('\n\n');
    if (cut < limit / 2) cut = window.lastIndexOf('\n');
    if (cut < limit / 2) cut = window.lastIndexOf(' ');
    if (cut <= 0) cut = limit;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

export function register(host: Host): void {
  host.telegram.command(
    'codex',
    async (ctx) => {
      const task = ctx.args.trim();
      if (!task) {
        await ctx.reply(
          'Usage: /codex <task>\nExample: /codex write a Python function that parses an ISO 8601 duration',
        );
        return;
      }
      await ctx.reply('Handing this to Codex…');
      const conversationId = conversationIdForChat(host.db, ctx.chatId);
      const outcome = await runHandoff(host, {
        task,
        source: 'command',
        chatId: ctx.chatId,
        ...(conversationId !== undefined ? { conversationId } : {}),
      });
      if (!outcome.ok) {
        await ctx.reply(outcome.message);
        return;
      }
      for (const part of splitForTelegram(outcome.result.text)) {
        await ctx.reply(part);
      }
    },
    'Send a task straight to Codex: /codex <task>',
  );

  host.telegram.command(
    'codexstatus',
    async (ctx) => {
      const cfg = readSettings(host);
      const authed = readTokens(host) !== null;
      const day = localDay(Date.now(), cfg.timeZone);
      const u = usageToday(host.db, day);
      const lines = [
        `Codex status (${day})`,
        `  Auth:      ${authed ? 'connected' : 'NOT connected — run `modulus auth modulus-codex`'}`,
        `  Model:     ${cfg.model}`,
        `  Calls:     ${u.calls}/${cfg.ceiling} used today`,
        `  Tokens:    ${u.promptTokens} in / ${u.completionTokens} out`,
      ];
      await ctx.reply(lines.join('\n'));
    },
    "Today's Codex usage and remaining budget",
  );

  host.telegram.command(
    'codexlogout',
    async (ctx) => {
      if (readTokens(host) === null) {
        await ctx.reply('Codex is not connected — nothing to forget.');
        return;
      }
      clearTokens(host);
      await ctx.reply(
        'Forgot the stored Codex credentials. Run `modulus auth modulus-codex` to reconnect.',
      );
    },
    'Forget stored Codex credentials',
  );

  void host;
}
