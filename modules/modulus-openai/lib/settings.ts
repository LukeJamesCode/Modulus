import type { Host } from '../../../src/core/modules.js';

export interface EndpointSupports {
  tools: boolean;
  json_object: boolean;
  reasoning_field?: string;
}

export interface EndpointConfig {
  alias: string;
  baseURL: string;
  apiKeySecret: string;
  models: string[];
  supports: EndpointSupports;
  region?: string;
  dailyCallLimit?: number;
  dailyTokenLimit?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
}

export interface OpenAICompatSettings {
  endpoints: EndpointConfig[];
  allowedBaseURLs: string[];
  timeZone?: string;
}

function parseJsonSetting<T>(value: string, fallback: T, label: string): T {
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  try {
    return JSON.parse(trimmed) as T;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`${label} must be valid JSON: ${msg}`);
  }
}

function normalizeBaseURL(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`baseURL must be a valid URL (got "${raw}")`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`baseURL must use http or https (got "${raw}")`);
  }
  return url.toString().replace(/\/$/, '');
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function numberOrUndefined(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
  return Math.floor(value);
}

function normalizeEndpoint(raw: unknown, index: number): EndpointConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`endpoints[${index}] must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  const alias = requireString(obj['alias'], `endpoints[${index}].alias`);
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(alias)) {
    throw new Error(`endpoints[${index}].alias must match /^[a-z0-9][a-z0-9_-]*$/i`);
  }
  const apiKeySecret = requireString(obj['apiKeySecret'], `endpoints[${index}].apiKeySecret`);
  if (!apiKeySecret.startsWith('secret://')) {
    throw new Error(`endpoints[${index}].apiKeySecret must be a secret:// handle`);
  }
  const modelsRaw = obj['models'];
  if (!Array.isArray(modelsRaw) || modelsRaw.length === 0) {
    throw new Error(`endpoints[${index}].models must be a non-empty string array`);
  }
  const models = modelsRaw.map((model, modelIndex) =>
    requireString(model, `endpoints[${index}].models[${modelIndex}]`),
  );
  const supportsRaw =
    obj['supports'] && typeof obj['supports'] === 'object' && !Array.isArray(obj['supports'])
      ? (obj['supports'] as Record<string, unknown>)
      : {};
  const supports: EndpointSupports = {
    tools: supportsRaw['tools'] === true,
    json_object: supportsRaw['json_object'] === true,
  };
  if (typeof supportsRaw['reasoning_field'] === 'string' && supportsRaw['reasoning_field']) {
    supports.reasoning_field = supportsRaw['reasoning_field'];
  }
  const out: EndpointConfig = {
    alias,
    baseURL: normalizeBaseURL(requireString(obj['baseURL'], `endpoints[${index}].baseURL`)),
    apiKeySecret,
    models,
    supports,
  };
  if (typeof obj['region'] === 'string' && obj['region'].trim()) out.region = obj['region'].trim();
  const dailyCallLimit = numberOrUndefined(
    obj['dailyCallLimit'],
    `endpoints[${index}].dailyCallLimit`,
  );
  const dailyTokenLimit = numberOrUndefined(
    obj['dailyTokenLimit'],
    `endpoints[${index}].dailyTokenLimit`,
  );
  const maxOutputTokens = numberOrUndefined(
    obj['maxOutputTokens'],
    `endpoints[${index}].maxOutputTokens`,
  );
  const timeoutMs = numberOrUndefined(obj['timeoutMs'], `endpoints[${index}].timeoutMs`);
  if (dailyCallLimit !== undefined) out.dailyCallLimit = dailyCallLimit;
  if (dailyTokenLimit !== undefined) out.dailyTokenLimit = dailyTokenLimit;
  if (maxOutputTokens !== undefined) out.maxOutputTokens = maxOutputTokens;
  if (timeoutMs !== undefined) out.timeoutMs = timeoutMs;
  return out;
}

export function readSettings(host: Host): OpenAICompatSettings {
  const rawEndpoints = parseJsonSetting<unknown[]>(
    host.settings.get<string>('endpoints', '[]'),
    [],
    'endpoints',
  );
  if (!Array.isArray(rawEndpoints)) throw new Error('endpoints must be a JSON array');
  const endpoints = rawEndpoints.map(normalizeEndpoint);
  const aliases = new Set<string>();
  for (const endpoint of endpoints) {
    if (aliases.has(endpoint.alias))
      throw new Error(`duplicate endpoint alias "${endpoint.alias}"`);
    aliases.add(endpoint.alias);
  }

  const allowedRaw = host.settings.get<string>('allowed_base_urls', '');
  let allowedBaseURLs = parseJsonSetting<unknown[]>(allowedRaw, [], 'allowed_base_urls').map(
    (v, i) => normalizeBaseURL(requireString(v, `allowed_base_urls[${i}]`)),
  );
  if (!allowedRaw.trim() && endpoints.length > 0) {
    allowedBaseURLs = [...new Set(endpoints.map((endpoint) => endpoint.baseURL))];
    host.settings.set('allowed_base_urls', JSON.stringify(allowedBaseURLs));
  }
  const timeZone = host.settings.get<string>('time_zone', '');
  return {
    endpoints,
    allowedBaseURLs,
    ...(timeZone ? { timeZone } : {}),
  };
}

export function findEndpoint(settings: OpenAICompatSettings, alias: string): EndpointConfig | null {
  return settings.endpoints.find((endpoint) => endpoint.alias === alias) ?? null;
}
