// Persistent CLI config: ~/.modulus/config.json.
//
// Phase 1 read everything from environment. Phase 3 introduces a real config
// file written by `modulus init` and edited by `modulus config`. Environment
// variables still win, so existing deployments keep working - file values are
// only read when the matching env var is unset.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface ModulusConfig {
  telegram: {
    token: string;
    allowedIds: number[];
  };
  ollama: {
    url: string;
  };
  models: {
    chat: string;
    reason?: string;
    // Optional tool-use profile. When set, the orchestrator routes any chat
    // call that has tool schemas attached through this model instead of
    // `chat`. Useful when the chat model is small/fast and a separate model
    // is better at picking the right tool and shaping its arguments.
    tools?: string;
  };
  // Hardware tier. Surfaced by `modulus status` / `modulus doctor`, and used at
  // boot to scale the LLM context windows and prompt budget (see
  // src/cli/profiles.ts). No feature is gated on it.
  tier?: 'small' | 'standard' | 'heavy';
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  // Integrated web panel, served in-process by the daemon (see src/panel/).
  // enabled defaults true; bind is loopback-only by default — LAN exposure is
  // an explicit opt-in. The bearer token is NOT here; it lives in a private
  // file (~/.modulus/panel-token) so config.json stays safe to share.
  panel?: {
    enabled?: boolean;
    port?: number;
    bind?: string;
  };
  // Instant Responses: send a canned ack before a slow turn. Default on; the
  // behaviour is wired in Phase 2, but the toggle persists here from Phase 1 so
  // the Settings UI has something to read/write.
  instantResponses?: {
    enabled?: boolean;
  };
  // Long-term memory background jobs. `extraction` pulls 0–2 durable user facts
  // from each chat turn (default on for Standard/Heavy, off for Small — the
  // tier-aware default is resolved at boot in start.ts, so an unset value stays
  // undefined here). `dreaming` is the deterministic nightly consolidation pass
  // (default on). See src/core/memory-extraction.ts and src/core/dreaming.ts.
  memory?: {
    extraction?: { enabled?: boolean };
    dreaming?: { enabled?: boolean };
  };
}

// Whitelist of accepted hardware tiers. An unknown value (from env or disk)
// would make profilesForTier → TUNING[tier] undefined and crash boot, so we
// normalize to `undefined` (treated downstream as 'small') instead of throwing.
const VALID_TIERS = ['small', 'standard', 'heavy'] as const;

function normalizeTier(v: string | undefined): ModulusConfig['tier'] | undefined {
  return (VALID_TIERS as readonly string[]).includes(v ?? '')
    ? (v as ModulusConfig['tier'])
    : undefined;
}

export const CONFIG_VERSION = 3;

interface ConfigOnDisk extends ModulusConfig {
  version: number;
}

export type ModulusConfigInput = Partial<ModulusConfig> &
  Pick<ModulusConfig, 'telegram' | 'ollama' | 'models'>;

const DEFAULTS: ModulusConfig = {
  telegram: { token: '', allowedIds: [] },
  ollama: { url: 'http://localhost:11434' },
  models: { chat: 'qwen3.5:0.8b' },
  logLevel: 'info',
  panel: { enabled: true, port: 7777, bind: '127.0.0.1' },
  instantResponses: { enabled: true },
};

export function homeDir(): string {
  return process.env['MODULUS_HOME']?.trim() || join(homedir(), '.modulus');
}

export function configPath(home: string = homeDir()): string {
  return join(home, 'config.json');
}

// True once a config.json has been written — i.e. the user has been through the
// wizard (or `modulus init`). Used to treat setup as "done" even on a panel-only
// install with no Telegram token, so the daemon boots fully instead of dropping
// back into the setup wizard. Telegram supplied purely via env still counts as
// configured on its own (see start.ts), so env-only deployments don't depend on
// this file existing.
export function configFileExists(home: string = homeDir()): boolean {
  return existsSync(configPath(home));
}

export function loadConfig(home: string = homeDir()): ModulusConfig {
  const file = configPath(home);
  if (!existsSync(file)) return cloneDefaults();
  const raw = readFileSync(file, 'utf8');
  let parsed: Partial<ConfigOnDisk>;
  try {
    parsed = JSON.parse(raw) as Partial<ConfigOnDisk>;
  } catch (e) {
    throw new Error(`config at ${file} is not valid JSON: ${(e as Error).message}`);
  }
  return mergeWithDefaults(parsed);
}

export function saveConfig(cfg: ModulusConfigInput, home: string = homeDir()): void {
  ensurePrivateDir(home);
  const merged = mergeWithDefaults(cfg as Partial<ConfigOnDisk>);
  const out: ConfigOnDisk = { version: CONFIG_VERSION, ...merged };
  const file = configPath(home);
  ensurePrivateDir(dirname(file));
  writeFileSync(file, JSON.stringify(out, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  ensurePrivateFile(file);
}

// Compose the runtime view: env wins over the file, file wins over defaults.
export function effectiveConfig(home: string = homeDir()): ModulusConfig {
  const file = loadConfig(home);
  const env = process.env;
  const allowedFromEnv = env['TELEGRAM_ALLOWED_IDS']?.trim();
  const ollamaUrl = env['OLLAMA_URL']?.trim() || file.ollama.url;
  validateOllamaUrl(ollamaUrl);
  return {
    telegram: {
      token: env['TELEGRAM_BOT_TOKEN']?.trim() || file.telegram.token,
      allowedIds: allowedFromEnv ? parseAllowedIds(allowedFromEnv) : file.telegram.allowedIds,
    },
    ollama: {
      url: ollamaUrl,
    },
    models: {
      chat: env['MODULUS_CHAT_MODEL']?.trim() || file.models.chat,
      ...(env['MODULUS_REASON_MODEL']?.trim() || file.models.reason
        ? { reason: env['MODULUS_REASON_MODEL']?.trim() || file.models.reason }
        : {}),
      ...(env['MODULUS_TOOLS_MODEL']?.trim() || file.models.tools
        ? { tools: env['MODULUS_TOOLS_MODEL']?.trim() || file.models.tools }
        : {}),
    },
    ...(() => {
      const tier = normalizeTier(env['MODULUS_TIER']?.trim()) ?? normalizeTier(file.tier);
      return tier ? { tier } : {};
    })(),
    logLevel: ((env['MODULUS_LOG_LEVEL']?.trim() as ModulusConfig['logLevel']) ||
      file.logLevel) as ModulusConfig['logLevel'],
    panel: {
      // Only an explicit 'false' opts the panel out; anything else keeps the
      // file/default value (on). Mirrors the panel.enabled default.
      enabled:
        env['MODULUS_PANEL_ENABLED']?.trim() === 'false' ? false : (file.panel?.enabled ?? true),
      port: (() => {
        const raw = env['MODULUS_PANEL_PORT']?.trim();
        const n = raw ? Number.parseInt(raw, 10) : NaN;
        return Number.isFinite(n) && n > 0 ? n : (file.panel?.port ?? 7777);
      })(),
      bind: env['MODULUS_PANEL_BIND']?.trim() || file.panel?.bind || '127.0.0.1',
    },
    instantResponses: {
      enabled:
        env['MODULUS_INSTANT_RESPONSES']?.trim() === 'false'
          ? false
          : (file.instantResponses?.enabled ?? true),
    },
    // Left unset (undefined enabled) unless explicitly chosen, so start.ts can
    // apply the tier-aware extraction default. env 'true'/'false' wins over file.
    memory: {
      extraction: {
        enabled: envBool(env['MODULUS_MEMORY_EXTRACTION'], file.memory?.extraction?.enabled),
      },
      dreaming: {
        enabled: envBool(env['MODULUS_MEMORY_DREAMING'], file.memory?.dreaming?.enabled),
      },
    },
  };
}

// Tri-state env override: explicit 'true'/'false' wins, else the file value
// (which may itself be undefined → caller applies its own default).
function envBool(raw: string | undefined, fallback: boolean | undefined): boolean | undefined {
  const v = raw?.trim();
  if (v === 'true') return true;
  if (v === 'false') return false;
  return fallback;
}

// SSRF guard for the Ollama base URL. Ollama is always a separate process
// running locally or on the operator's own network; pointing it at AWS/GCP
// metadata services or random external IPs has no legitimate use and would
// leak whatever Ollama proxies (model lists, system info).
//
// Allowed: http(s)://, hostnames that are either loopback literals, or DNS
// names matching a conservative shape. Cloud metadata IPs and 0.0.0.0 are
// explicitly rejected.
const METADATA_HOSTS = new Set([
  '169.254.169.254', // AWS / GCP / Azure metadata
  'metadata.google.internal',
  '0.0.0.0',
]);

export function validateOllamaUrl(raw: string): void {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`invalid OLLAMA_URL: ${raw}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`OLLAMA_URL must use http(s): ${raw}`);
  }
  const host = u.hostname.toLowerCase();
  if (METADATA_HOSTS.has(host) || host.startsWith('169.254.')) {
    throw new Error(`OLLAMA_URL points at a metadata / link-local host: ${host}`);
  }
  // Catch IPv4-mapped IPv6 forms of metadata / link-local. WHATWG URL parsing
  // normalizes `::ffff:169.254.169.254` to `[::ffff:a9fe:a9fe]`, so we have to
  // recognize both the decimal-tail form and the hex form. Anything mapping
  // into 169.254/16 is link-local and reachable from this box.
  const v6 = host.replace(/^\[|\]$/g, '');
  const v4Tail = v6.match(/(?:^|:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (v4Tail?.[1]) {
    const ipv4 = v4Tail[1].toLowerCase();
    if (ipv4.startsWith('169.254.') || METADATA_HOSTS.has(ipv4)) {
      throw new Error(`OLLAMA_URL points at a metadata / link-local host: ${host}`);
    }
  }
  // a9fe == 169.254 — any `::ffff:a9fe:*` is inside link-local.
  if (/(^|:):ffff:a9fe:[0-9a-f]{1,4}$/i.test(v6) || /(^|:):ffff:0:0$/i.test(v6)) {
    throw new Error(`OLLAMA_URL points at a metadata / link-local host: ${host}`);
  }
  // Plain IPv6 link-local fe80::/10 — no Ollama lives on link-local.
  if (/^fe[89ab][0-9a-f]?:/i.test(v6)) {
    throw new Error(`OLLAMA_URL points at an IPv6 link-local host: ${host}`);
  }
  // DNS name OR loopback IP; reject anything weirder (square-bracketed IPv6
  // literals are allowed because URL parsing normalizes them).
  const looksLikeDnsOrIp = /^[a-z0-9.\-:[\]]+$/i.test(host);
  if (!looksLikeDnsOrIp) {
    throw new Error(`OLLAMA_URL has unusual hostname: ${host}`);
  }
}

export function parseAllowedIds(raw: string): number[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      // Telegram user IDs are positive integers; reject partial garbage like
      // "12abc" that Number.parseInt would silently truncate to 12.
      if (!/^\d+$/.test(s)) throw new Error(`invalid Telegram user id: ${s}`);
      const n = Number.parseInt(s, 10);
      if (!Number.isFinite(n)) throw new Error(`invalid Telegram user id: ${s}`);
      return n;
    });
}

function cloneDefaults(): ModulusConfig {
  return structuredClone(DEFAULTS);
}

function mergeWithDefaults(input: Partial<ConfigOnDisk>): ModulusConfig {
  const base = cloneDefaults();
  if (input.telegram?.token) base.telegram.token = input.telegram.token;
  if (Array.isArray(input.telegram?.allowedIds)) {
    base.telegram.allowedIds = input.telegram.allowedIds.filter((n) => Number.isFinite(n));
  }
  if (input.ollama?.url) base.ollama.url = input.ollama.url;
  if (input.models?.chat) base.models.chat = input.models.chat;
  if (input.models?.reason) base.models.reason = input.models.reason;
  if (input.models?.tools) base.models.tools = input.models.tools;
  const tier = normalizeTier(input.tier);
  if (tier) base.tier = tier;
  if (input.logLevel) base.logLevel = input.logLevel;
  if (input.panel && base.panel) {
    if (typeof input.panel.enabled === 'boolean') base.panel.enabled = input.panel.enabled;
    if (typeof input.panel.port === 'number' && Number.isFinite(input.panel.port))
      base.panel.port = input.panel.port;
    if (input.panel.bind) base.panel.bind = input.panel.bind;
  }
  if (input.instantResponses && base.instantResponses) {
    if (typeof input.instantResponses.enabled === 'boolean')
      base.instantResponses.enabled = input.instantResponses.enabled;
  }
  if (input.memory) {
    const mem: NonNullable<ModulusConfig['memory']> = {};
    if (typeof input.memory.extraction?.enabled === 'boolean')
      mem.extraction = { enabled: input.memory.extraction.enabled };
    if (typeof input.memory.dreaming?.enabled === 'boolean')
      mem.dreaming = { enabled: input.memory.dreaming.enabled };
    if (mem.extraction || mem.dreaming) base.memory = mem;
  }
  return base;
}

// Secrets live under MODULUS_HOME (~/.modulus by default). Keep that tree
// owner-only even when the process umask is permissive or the directory/file
// already existed with wider permissions. chmod can fail on non-POSIX
// filesystems, so these helpers are best-effort rather than startup-fatal.
export function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try {
    chmodSync(path, 0o700);
  } catch {
    // Best-effort on filesystems that do not support POSIX permissions.
  }
}

export function ensurePrivateFile(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best-effort on filesystems that do not support POSIX permissions.
  }
}
