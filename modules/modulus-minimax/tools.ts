import type { Host } from '../../src/core/modules.js';
import { createMinimaxModelProvider } from './lib/provider.js';

export function register(host: Host): void {
  // Register the MiniMax LLM Provider so the system can route requests to it.
  host.llm.registerProvider?.(createMinimaxModelProvider(host));
}
