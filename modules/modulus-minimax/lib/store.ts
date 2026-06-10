import type { Host } from '../../../src/core/modules.js';

export class MinimaxNotAuthedError extends Error {
  constructor() {
    super('MiniMax is not configured. Run `modulus auth modulus-minimax` first.');
    this.name = 'MinimaxNotAuthedError';
  }
}

export const KEYS = {
  apiKey: 'api_key',
} as const;

export function readApiKey(host: Host): string | null {
  const apiKey = host.settings.get<string>(KEYS.apiKey, '');
  return apiKey || null;
}

export function writeApiKey(host: Host, apiKey: string): void {
  host.settings.set(KEYS.apiKey, apiKey);
}

export function clearApiKey(host: Host): void {
  host.settings.set(KEYS.apiKey, '');
}

export function getValidApiKey(host: Host): string {
  const apiKey = readApiKey(host);
  if (!apiKey) throw new MinimaxNotAuthedError();
  return apiKey;
}
