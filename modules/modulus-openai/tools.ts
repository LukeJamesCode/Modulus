import type { Host } from '../../src/core/modules.js';
import { readSettings } from './lib/settings.js';
import { createOpenAICompatibleProvider } from './lib/provider.js';

export function register(host: Host): void {
  const settings = readSettings(host);
  for (const endpoint of settings.endpoints) {
    host.llm.registerProvider?.(createOpenAICompatibleProvider(host, endpoint, settings));
  }
}
