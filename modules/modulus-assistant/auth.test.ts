import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { setupCallbackServer, isValidIpv4 } from './auth.js';

test('OAuth callback rejects state mismatch', async () => {
  const { actualPort, code } = setupCallbackServer('127.0.0.1', 0, 'expected-state');
  const port = await actualPort;
  const rejected = assert.rejects(code, /state mismatch/i);
  const res = await fetch(`http://127.0.0.1:${port}/callback?code=abc123&state=wrong-state`);
  assert.equal(res.status, 200);
  await rejected;
});

test('LAN callback input accepts only plain IPv4 addresses', () => {
  assert.equal(isValidIpv4('192.168.1.42'), true);
  assert.equal(isValidIpv4('127.0.0.1'), true);
  assert.equal(isValidIpv4('http://192.168.1.42'), false);
  assert.equal(isValidIpv4('192.168.1.999'), false);
  assert.equal(isValidIpv4('192.168.001.42'), false);
});
