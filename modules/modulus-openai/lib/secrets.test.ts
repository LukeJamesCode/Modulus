import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import type { Host } from '../../../src/core/modules.js';
import { resolveSecret, settingKeyForSecretHandle } from './secrets.js';

function hostWithSettings(values: Record<string, string>): Host {
  return {
    settings: {
      get<T>(key: string, fallback?: T): T {
        return (values[key] ?? fallback) as T;
      },
      set(): void {},
      all(): Record<string, string | number | boolean> {
        return values;
      },
    },
  } as unknown as Host;
}

test('settingKeyForSecretHandle derives a stable extension setting key', () => {
  assert.equal(
    settingKeyForSecretHandle('secret://openai-compatible/deepseek'),
    'secret_openai-compatible_deepseek',
  );
});

test('resolveSecret reads the legacy derived setting key first', () => {
  const host = hostWithSettings({
    'secret_openai-compatible_deepseek': 'sk-direct',
    secrets: '{"secret://openai-compatible/deepseek":"sk-map"}',
  });
  assert.equal(resolveSecret(host, 'secret://openai-compatible/deepseek'), 'sk-direct');
});

test('resolveSecret reads the schema-visible secrets map', () => {
  const host = hostWithSettings({
    secrets: '{"secret://openai-compatible/deepseek":"sk-map"}',
  });
  assert.equal(resolveSecret(host, 'secret://openai-compatible/deepseek'), 'sk-map');
});

test('resolveSecret fails loudly on invalid secrets JSON', () => {
  const host = hostWithSettings({ secrets: '{not json' });
  assert.throws(
    () => resolveSecret(host, 'secret://openai-compatible/deepseek'),
    /secrets must be a JSON object/,
  );
});
