import type { Host } from '../../src/core/modules.js';
import { localDay, usageByEndpointToday, usageToday } from './lib/budget.js';
import { findEndpoint, readSettings } from './lib/settings.js';

const TELEGRAM_LIMIT = 4000;

function splitForTelegram(text: string, limit = TELEGRAM_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
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

function unquotePrompt(prompt: string): string {
  const trimmed = prompt.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function register(host: Host): void {
  host.telegram.command(
    'oai',
    async (ctx) => {
      const [alias, ...promptParts] = ctx.args.trim().split(/\s+/);
      const prompt = unquotePrompt(promptParts.join(' '));
      if (!alias || !prompt) {
        await ctx.reply('Usage: /oai <alias> <prompt>\nExample: /oai deepseek "hello"');
        return;
      }
      const settings = readSettings(host);
      const endpoint = findEndpoint(settings, alias);
      if (!endpoint) {
        await ctx.reply(
          `No endpoint named "${alias}". Run /oaiendpoints to see configured aliases.`,
        );
        return;
      }
      await ctx.reply(`Sending this to ${alias}...`);
      let text = '';
      try {
        for await (const chunk of host.llm.chat({
          profile: { model: `${endpoint.alias}:${endpoint.models[0]}` },
          messages: [{ role: 'user', content: prompt }],
          context: { chatId: ctx.chatId },
          ...(endpoint.maxOutputTokens !== undefined
            ? { maxTokens: endpoint.maxOutputTokens }
            : {}),
          ...(endpoint.timeoutMs !== undefined ? { timeoutMs: endpoint.timeoutMs } : {}),
        })) {
          text += chunk.delta;
          if (chunk.done) break;
        }
      } catch (e) {
        await ctx.reply(e instanceof Error ? e.message : String(e));
        return;
      }
      for (const part of splitForTelegram(text || '(no reply)')) {
        await ctx.reply(part);
      }
    },
    'Send a one-shot prompt to an OpenAI-compatible endpoint',
  );

  host.telegram.command(
    'oaistatus',
    async (ctx) => {
      const settings = readSettings(host);
      const day = localDay(Date.now(), settings.timeZone);
      const usageRows = new Map(
        usageByEndpointToday(host.db, day).map((row) => [row.endpointAlias, row]),
      );
      const lines = [`OpenAI-compatible usage (${day})`];
      for (const endpoint of settings.endpoints) {
        const u = usageRows.get(endpoint.alias) ?? usageToday(host.db, day, endpoint.alias);
        const callLimit =
          endpoint.dailyCallLimit && endpoint.dailyCallLimit > 0
            ? `/${endpoint.dailyCallLimit}`
            : '';
        const tokenLimit =
          endpoint.dailyTokenLimit && endpoint.dailyTokenLimit > 0
            ? `/${endpoint.dailyTokenLimit}`
            : '';
        lines.push(
          `  ${endpoint.alias}: ${u.calls}${callLimit} calls, ${u.totalTokens}${tokenLimit} tokens (${u.promptTokens} in / ${u.completionTokens} out)`,
        );
      }
      if (settings.endpoints.length === 0) lines.push('  No endpoints configured.');
      await ctx.reply(lines.join('\n'));
    },
    "Today's OpenAI-compatible endpoint usage",
  );

  host.telegram.command(
    'oaiendpoints',
    async (ctx) => {
      const settings = readSettings(host);
      if (settings.endpoints.length === 0) {
        await ctx.reply('No OpenAI-compatible endpoints configured.');
        return;
      }
      const lines = ['Configured OpenAI-compatible endpoints:'];
      for (const endpoint of settings.endpoints) {
        const allowed = settings.allowedBaseURLs.includes(endpoint.baseURL) ? 'allowed' : 'blocked';
        lines.push(
          `  ${endpoint.alias}: ${endpoint.baseURL} (${allowed}) models: ${endpoint.models.join(', ')}`,
        );
      }
      await ctx.reply(lines.join('\n'));
    },
    'List configured OpenAI-compatible endpoints',
  );
}
