// Regression: Ollama baseUrl must not be allowed to point at link-local /
// cloud-metadata endpoints. A user-controlled config would otherwise let an
// attacker pivot Ollama into an SSRF probe.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { validateOllamaUrl } from './config-store.js';

test('validateOllamaUrl accepts loopback and DNS hosts', () => {
  validateOllamaUrl('http://localhost:11434');
  validateOllamaUrl('http://127.0.0.1:11434');
  validateOllamaUrl('https://ollama.internal:11434');
  validateOllamaUrl('http://[::1]:11434');
});

test('validateOllamaUrl rejects cloud-metadata IPs', () => {
  assert.throws(() => validateOllamaUrl('http://169.254.169.254/latest/meta-data/'));
  assert.throws(() => validateOllamaUrl('http://metadata.google.internal/'));
  assert.throws(() => validateOllamaUrl('http://0.0.0.0:11434'));
});

test('validateOllamaUrl rejects non-http(s) protocols', () => {
  assert.throws(() => validateOllamaUrl('file:///etc/passwd'));
  assert.throws(() => validateOllamaUrl('ftp://example.com/'));
});

test('validateOllamaUrl rejects garbage', () => {
  assert.throws(() => validateOllamaUrl('not a url'));
  assert.throws(() => validateOllamaUrl(''));
});

test('validateOllamaUrl rejects IPv4-mapped IPv6 metadata host', () => {
  assert.throws(() => validateOllamaUrl('http://[::ffff:169.254.169.254]:11434'));
  assert.throws(() => validateOllamaUrl('http://[::ffff:0.0.0.0]:11434'));
});

test('validateOllamaUrl rejects IPv6 link-local', () => {
  assert.throws(() => validateOllamaUrl('http://[fe80::1]:11434'));
});
