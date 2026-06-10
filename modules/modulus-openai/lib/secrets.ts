import type { Host } from '../../../src/core/modules.js';

export class SecretNotFoundError extends Error {
  constructor(handle: string, settingKey: string) {
    super(`Missing API key for ${handle}. Store it in modulus-openai setting "${settingKey}".`);
    this.name = 'SecretNotFoundError';
  }
}

export function settingKeyForSecretHandle(handle: string): string {
  if (!handle.startsWith('secret://')) {
    throw new Error('API key references must use secret:// handles');
  }
  const path = handle.slice('secret://'.length).replace(/^\/+/, '');
  if (!path) throw new Error('secret:// handle must include a path');
  return `secret_${path.replace(/[^a-z0-9_-]+/gi, '_')}`;
}

function readSecretMap(host: Host): Record<string, string> {
  const raw = host.settings.get<string>('secrets', '{}');
  if (!raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`secrets must be a JSON object mapping secret:// handles to API keys: ${msg}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('secrets must be a JSON object mapping secret:// handles to API keys');
  }
  const out: Record<string, string> = {};
  for (const [handle, value] of Object.entries(parsed)) {
    if (typeof value === 'string' && value) out[handle] = value;
  }
  return out;
}

export function resolveSecret(host: Host, handle: string): string {
  const key = settingKeyForSecretHandle(handle);
  const directValue = host.settings.get<string>(key, '');
  if (directValue) return directValue;
  const mappedValue = readSecretMap(host)[handle];
  if (mappedValue) return mappedValue;
  throw new SecretNotFoundError(handle, key);
}
