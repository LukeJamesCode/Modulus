import type { Host } from '../../src/core/modules.js';
import { writeApiKey } from './lib/store.js';

export function register(host: Host): void {
  host.auth.flow({
    label: 'Authorize MiniMax',
    run: async (io) => {
      const apiKey = await io.prompt('Paste your MiniMax API Key:', { secret: true });
      if (!apiKey) {
        throw new Error('API Key cannot be empty');
      }
      writeApiKey(host, apiKey);
      return {};
    },
  });
}
