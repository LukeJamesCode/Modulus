import type { Host } from '../../../src/core/modules.js';
import type { LLMProvider, LLMProviderChatOptions } from '../../../src/core/llm.js';
import { localDay, usageToday, recordCall } from './budget.js';
import { getValidApiKey } from './store.js';
import { callMinimaxStream, MinimaxApiError } from './minimax.js';

const ALIAS = 'minimax';

function resolveMinimaxModel(modelRef: string, fallback: string): string {
  const prefix = `${ALIAS}:`;
  if (modelRef.startsWith(prefix) && modelRef.length > prefix.length) {
    return modelRef.slice(prefix.length);
  }
  return fallback;
}

export function createMinimaxModelProvider(host: Host): LLMProvider {
  return {
    id: ALIAS,
    models: () => {
      const defaultModel = host.settings.get<string>('model', 'abab6.5s-chat');
      return [ALIAS, `${ALIAS}:${defaultModel}`];
    },
    health: async () => {
      const defaultModel = host.settings.get<string>('model', 'abab6.5s-chat');
      let ok = false;
      try {
        getValidApiKey(host);
        ok = true;
      } catch {
        ok = false;
      }
      return { ok, models: [ALIAS, `${ALIAS}:${defaultModel}`] };
    },
    chat: async function* (opts: LLMProviderChatOptions) {
      const now = Date.now();
      const defaultModel = host.settings.get<string>('model', 'abab6.5s-chat');
      const ceiling = host.settings.get<number>('ceiling', 1000000);
      const day = localDay(now);

      if (ceiling > 0) {
        const usage = usageToday(host.db, day);
        const usedTokens = usage.promptTokens + usage.completionTokens;
        if (usedTokens >= ceiling) {
          recordCall(host.db, {
            day,
            source: 'provider',
            status: 'denied',
            now,
            ...(opts.context?.chatId !== undefined ? { chatId: opts.context.chatId } : {}),
          });
          throw new Error(
            `Daily MiniMax token budget reached (${usedTokens}/${ceiling}). Set a higher ceiling via \`modulus config modulus-minimax\`.`,
          );
        }
      }

      const apiKey = getValidApiKey(host);
      const actualModel = resolveMinimaxModel(opts.model, defaultModel);

      try {
        let finalPromptTokens = 0;
        let finalCompletionTokens = 0;

        for await (const chunk of callMinimaxStream({
          ...opts,
          apiKey,
          model: actualModel,
          timeoutMs: host.settings.get<number>('timeout_ms', 180000),
          log: host.log,
        })) {
          if (chunk.promptTokens !== undefined) finalPromptTokens = chunk.promptTokens;
          if (chunk.completionTokens !== undefined) finalCompletionTokens = chunk.completionTokens;

          yield {
            ...chunk,
            model: `${ALIAS}:${actualModel}`,
          };
        }

        recordCall(host.db, {
          day,
          source: 'provider',
          status: 'ok',
          now,
          ...(opts.context?.chatId !== undefined ? { chatId: opts.context.chatId } : {}),
          promptTokens: finalPromptTokens,
          completionTokens: finalCompletionTokens,
        });
      } catch (e) {
        recordCall(host.db, {
          day,
          source: 'provider',
          status: 'error',
          now,
          ...(opts.context?.chatId !== undefined ? { chatId: opts.context.chatId } : {}),
        });

        if (e instanceof MinimaxApiError && e.status === 401) {
          throw new Error('MiniMax API Key rejected (401). Re-run `modulus auth modulus-minimax`.');
        }
        throw e;
      }
    },
  };
}
