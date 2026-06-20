// Telegram command surface: /computer <goal> starts a watched desktop session,
// /computer stop halts it. Shares the one SessionManager with tools.ts via the
// runtime singleton, so stopping here halts a session the model started and
// vice versa.

import type { Host } from '../../src/core/modules.js';
import { getRuntime } from './runtime.js';

export function register(host: Host): void {
  const { manager, getConfig, sessionChat } = getRuntime(host);

  host.telegram.command(
    'computer',
    async (ctx) => {
      const arg = ctx.args.trim();
      if (arg.toLowerCase() === 'stop') {
        await ctx.reply(manager.stop() ? 'Stopping the session…' : 'Nothing is running.');
        return;
      }
      if (!arg) {
        await ctx.reply('Usage: /computer <what to do on screen>   (or: /computer stop)');
        return;
      }
      const cfg = getConfig();
      if (cfg.appAllowlist.length === 0) {
        await ctx.reply(
          'No apps are allowlisted yet. Set "Allowed apps" in the modulus-computer-use settings ' +
            '(e.g. notepad,chrome), then try again.',
        );
        return;
      }
      if (manager.isActive()) {
        await ctx.reply('A session is already running. Send "/computer stop" to halt it first.');
        return;
      }
      try {
        const { sessionId } = manager.start({ goal: arg, chatId: ctx.chatId });
        sessionChat.set(sessionId, ctx.chatId);
        await ctx.reply(
          `On it — session #${sessionId}: "${arg}". I'll post each step here; send "/computer stop" anytime.`,
        );
      } catch (e) {
        await ctx.reply(e instanceof Error ? e.message : String(e));
      }
    },
    'Operate the PC toward a goal (or "stop" to halt)',
  );
}
