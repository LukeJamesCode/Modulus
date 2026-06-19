import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { chmodSync, mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configPath,
  effectiveConfig,
  loadConfig,
  parseAllowedIds,
  saveConfig,
  type ModulusConfig,
} from './config-store.js';

function mkHome(): string {
  return mkdtempSync(join(tmpdir(), 'modulus-config-test-'));
}

function assertPrivateModes(home: string): void {
  if (process.platform === 'win32') return;
  assert.equal(statSync(home).mode & 0o777, 0o700);
  assert.equal(statSync(configPath(home)).mode & 0o777, 0o600);
}

test('loadConfig returns defaults when no file', () => {
  const home = mkHome();
  try {
    const cfg = loadConfig(home);
    assert.equal(cfg.telegram.token, '');
    assert.deepEqual(cfg.telegram.allowedIds, []);
    assert.equal(cfg.ollama.url, 'http://localhost:11434');
    assert.equal(cfg.models.chat, 'qwen3.5:0.8b');
    assert.equal(cfg.models.reason, undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('saveConfig + loadConfig round-trips', () => {
  const home = mkHome();
  try {
    const input: ModulusConfig = {
      telegram: { token: 'abc', allowedIds: [1, 2, 3] },
      ollama: { url: 'http://example:11434' },
      models: { chat: 'qwen3.5:0.5b', reason: 'qwen3.5:9b' },
      tier: 'standard',
      logLevel: 'debug',
      panel: { enabled: true, port: 7777, bind: '127.0.0.1' },
      instantResponses: { enabled: true },
    };
    saveConfig(input, home);
    const round = loadConfig(home);
    assert.deepEqual(round, input);
    const onDisk = JSON.parse(readFileSync(configPath(home), 'utf8'));
    assert.equal(onDisk.version, 3);
    assertPrivateModes(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('saveConfig + loadConfig round-trips the memory block', () => {
  const home = mkHome();
  try {
    const input: ModulusConfig = {
      telegram: { token: 'abc', allowedIds: [1] },
      ollama: { url: 'http://example:11434' },
      models: { chat: 'qwen3.5:0.5b' },
      tier: 'standard',
      logLevel: 'info',
      panel: { enabled: true, port: 7777, bind: '127.0.0.1' },
      instantResponses: { enabled: true },
      memory: { extraction: { enabled: false }, dreaming: { enabled: false } },
    };
    saveConfig(input, home);
    assert.deepEqual(loadConfig(home), input);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('memory toggles: env tri-state wins; unset leaves enabled undefined for the tier default', () => {
  const home = mkHome();
  try {
    saveConfig(
      {
        telegram: { token: 't', allowedIds: [1] },
        ollama: { url: 'http://x:11434' },
        models: { chat: 'c' },
      },
      home,
    );
    // No env and no file memory block → enabled stays undefined so start.ts can
    // apply the tier-aware default rather than a fixed boolean here.
    const eff = effectiveConfig(home);
    assert.equal(eff.memory?.extraction?.enabled, undefined);
    assert.equal(eff.memory?.dreaming?.enabled, undefined);

    const oldEnv = { ...process.env };
    process.env['MODULUS_MEMORY_EXTRACTION'] = 'false';
    process.env['MODULUS_MEMORY_DREAMING'] = 'true';
    try {
      const e2 = effectiveConfig(home);
      assert.equal(e2.memory?.extraction?.enabled, false);
      assert.equal(e2.memory?.dreaming?.enabled, true);
    } finally {
      process.env = oldEnv;
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('saveConfig accepts legacy-shaped config and drops retired provider fields', () => {
  const home = mkHome();
  try {
    const legacy = {
      telegram: { token: 'legacy-token', allowedIds: [42] },
      ollama: { url: 'http://legacy:11434' },
      models: { chat: 'legacy-chat' },
      openai: { baseUrl: 'https://legacy.example', apiKey: 'sk-old' },
      modelProviders: { chat: 'openai' },
    };
    saveConfig(legacy, home);
    const cfg = loadConfig(home);
    assert.equal(cfg.telegram.token, 'legacy-token');
    assert.equal(cfg.ollama.url, 'http://legacy:11434');
    assert.equal(cfg.models.chat, 'legacy-chat');
    const onDisk = JSON.parse(readFileSync(configPath(home), 'utf8'));
    assert.equal(onDisk.version, 3);
    assert.equal(onDisk.openai, undefined);
    assert.equal(onDisk.modelProviders, undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('environment overrides win in effectiveConfig', () => {
  const home = mkHome();
  try {
    saveConfig(
      {
        telegram: { token: 'file-token', allowedIds: [1] },
        ollama: { url: 'http://file:11434' },
        models: { chat: 'file-chat' },
      },
      home,
    );
    const oldEnv = { ...process.env };
    process.env['TELEGRAM_BOT_TOKEN'] = 'env-token';
    process.env['OLLAMA_URL'] = 'http://env:11434';
    process.env['MODULUS_CHAT_MODEL'] = 'env-chat';
    process.env['TELEGRAM_ALLOWED_IDS'] = '7,8';
    try {
      const eff = effectiveConfig(home);
      assert.equal(eff.telegram.token, 'env-token');
      assert.equal(eff.ollama.url, 'http://env:11434');
      assert.equal(eff.models.chat, 'env-chat');
      assert.deepEqual(eff.telegram.allowedIds, [7, 8]);
    } finally {
      process.env = oldEnv;
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('panel settings: defaults on, env overrides win', () => {
  const home = mkHome();
  try {
    saveConfig(
      {
        telegram: { token: 't', allowedIds: [1] },
        ollama: { url: 'http://x:11434' },
        models: { chat: 'c' },
      },
      home,
    );
    // No env, no panel in the file: defaults apply.
    assert.deepEqual(effectiveConfig(home).panel, {
      enabled: true,
      port: 7777,
      bind: '127.0.0.1',
    });
    const oldEnv = { ...process.env };
    process.env['MODULUS_PANEL_ENABLED'] = 'false';
    process.env['MODULUS_PANEL_PORT'] = '9090';
    process.env['MODULUS_PANEL_BIND'] = '0.0.0.0';
    try {
      assert.deepEqual(effectiveConfig(home).panel, {
        enabled: false,
        port: 9090,
        bind: '0.0.0.0',
      });
    } finally {
      process.env = oldEnv;
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('parseAllowedIds rejects non-numeric input', () => {
  assert.deepEqual(parseAllowedIds(' 1 ,  2,3 '), [1, 2, 3]);
  assert.throws(() => parseAllowedIds('1,abc,3'));
  assert.deepEqual(parseAllowedIds(',  ,'), []);
});

test('loadConfig throws on malformed JSON', () => {
  const home = mkHome();
  try {
    const path = configPath(home);
    saveConfig(
      {
        telegram: { token: '', allowedIds: [] },
        ollama: { url: 'x' },
        models: { chat: 'y' },
      },
      home,
    );
    // Corrupt the file.
    writeFileSync(path, '{not json');
    assert.throws(() => loadConfig(home), /not valid JSON/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('saveConfig tightens permissions on existing config paths', () => {
  const home = mkHome();
  try {
    chmodSync(home, 0o777);
    const path = configPath(home);
    writeFileSync(path, '{}', { mode: 0o666 });
    saveConfig(
      { telegram: { token: 'abc', allowedIds: [1] }, ollama: { url: 'x' }, models: { chat: 'y' } },
      home,
    );
    if (process.platform !== 'win32') {
      assert.equal(statSync(home).mode & 0o777, 0o700);
      assert.equal(statSync(path).mode & 0o777, 0o600);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
