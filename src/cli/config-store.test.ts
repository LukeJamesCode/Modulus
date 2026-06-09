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
