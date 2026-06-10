import test from 'node:test';
import assert from 'node:assert';
import { isSafeUrl } from './safe-url.js';

test('isSafeUrl', async () => {
  const blocked = [
    'http://localhost',
    'http://app.internal/x',
    'http://127.0.0.1',
    'http://169.254.169.254', // cloud metadata
    'http://10.0.0.5',
    'http://192.168.1.1',
    'http://172.16.0.1',
    'http://0.0.0.0',
    'http://[::1]/',
    'http://[fc00::1]/', // unique-local
    'http://[fe80::1]/', // link-local
    'http://[::ffff:127.0.0.1]/', // IPv4-mapped loopback
    'http://127.0.0.1.nip.io', // SSRF domain
    'file:///etc/passwd',
    'ftp://example.com',
  ];

  for (const url of blocked) {
    const res = await isSafeUrl(url);
    assert.strictEqual(res.ok, false, `Should block ${url}`);
  }

  const allowed = ['https://example.com', 'http://93.184.216.34'];

  for (const url of allowed) {
    const res = await isSafeUrl(url);
    assert.strictEqual(res.ok, true, `Should allow ${url}`);
  }
});
