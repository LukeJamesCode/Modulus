import type { Host } from '../../src/core/modules.js';
import { clearApiKey } from './lib/store.js';
import { localDay, usageToday } from './lib/budget.js';
import { createMinimaxModelProvider } from './lib/provider.js';

export function register(host: Host): void {
  host.telegram.command(
    'minimaxlogout',
    async (ctx) => {
      clearApiKey(host);
      await ctx.reply('MiniMax API Key cleared from Modulus.');
    },
    'Clear the stored MiniMax API key',
  );

  host.telegram.command(
    'minimaxstatus',
    async (ctx) => {
      const day = localDay(Date.now());
      const usage = usageToday(host.db, day);
      const ceiling = host.settings.get<number>('ceiling', 1000000);

      const lines = [
        `📊 **MiniMax Usage Today**`,
        `Calls: ${usage.calls}`,
        `Prompt Tokens: ${usage.promptTokens}`,
        `Completion Tokens: ${usage.completionTokens}`,
      ];

      if (ceiling > 0) {
        const total = usage.promptTokens + usage.completionTokens;
        const remainingTokens = Math.max(0, ceiling - total);
        lines.push(`Total Tokens: ${total} / ${ceiling}`);
        lines.push(`Remaining Tokens: ${remainingTokens}`);
      } else {
        lines.push(`Total Tokens: ${usage.promptTokens + usage.completionTokens}`);
      }

      await ctx.reply(lines.join('\\n'));
    },
    "Check today's MiniMax token budget and usage",
  );

  host.telegram.command(
    'minimax',
    async (ctx) => {
      const text = ctx.args.trim();
      if (!text) {
        await ctx.reply('Usage: /minimax <prompt>');
        return;
      }

      const defaultModel = host.settings.get<string>('model', 'abab6.5s-chat');
      const provider = createMinimaxModelProvider(host);

      try {
        let fullReply = '';
        const stream = provider.chat({
          profile: { model: `minimax:${defaultModel}` },
          model: `minimax:${defaultModel}`,
          messages: [{ role: 'user', content: text }],
          context: { chatId: ctx.chatId },
        });

        for await (const chunk of stream) {
          if (chunk.delta) {
            fullReply += chunk.delta;
          }
        }
        await ctx.reply(fullReply || '(no reply)');
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await ctx.reply(`MiniMax error: ${msg}`);
      }
    },
    'Run a one-shot query via MiniMax',
  );
}
