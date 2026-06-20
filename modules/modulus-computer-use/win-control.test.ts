// Key-combo translation is pure and platform-independent — the bulk of the
// testable surface in the Windows backend. The actual screen capture / input
// shells PowerShell and only works on a real Windows desktop, so that smoke
// test is opt-in behind MODULUS_CU_LIVE=1 to keep the default gate fast and
// deterministic.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { comboToSendKeys, createWindowsBackend, type SpawnFn } from './win-control.js';

test('comboToSendKeys: single letter shortcut', () => {
  assert.equal(comboToSendKeys('ctrl+s'), '^s');
});

test('comboToSendKeys: stacked modifiers', () => {
  assert.equal(comboToSendKeys('ctrl+shift+s'), '^+s');
});

test('comboToSendKeys: named keys', () => {
  assert.equal(comboToSendKeys('enter'), '{ENTER}');
  assert.equal(comboToSendKeys('alt+f4'), '%{F4}');
  assert.equal(comboToSendKeys('ctrl+shift+escape'), '^+{ESC}');
});

test('comboToSendKeys: brace-escapes SendKeys metacharacters', () => {
  // '+' is the combo delimiter so it can't be a literal key; '%' exercises the
  // same brace-escape path for a SendKeys metacharacter.
  assert.equal(comboToSendKeys('ctrl+%'), '^{%}');
});

test('comboToSendKeys: rejects the Windows key', () => {
  assert.throws(() => comboToSendKeys('win+r'), /Windows key/);
});

test('comboToSendKeys: rejects modifier-only and unknown keys', () => {
  assert.throws(() => comboToSendKeys('ctrl'), /only modifiers/);
  assert.throws(() => comboToSendKeys('frobnicate'), /unsupported key/);
});

// Live end-to-end capture against the real desktop. Opt-in so `npm test` never
// shells PowerShell or grabs the screen by default.
test(
  'capture writes a non-empty PNG (live)',
  { skip: process.env['MODULUS_CU_LIVE'] !== '1' || process.platform !== 'win32' },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'modulus-cu-live-'));
    try {
      const spawnFn: SpawnFn = (command, args, options) =>
        spawn(command, args ?? [], options ?? {}) as unknown as ReturnType<SpawnFn>;
      const backend = createWindowsBackend(spawnFn);
      const path = join(dir, 'shot.png');
      const shot = await backend.capture(path);
      assert.ok(shot.width > 0 && shot.height > 0, 'capture reported dimensions');
      assert.ok(statSync(path).size > 0, 'PNG file is non-empty');
      assert.ok(shot.base64.length > 0, 'base64 returned');
      const fg = await backend.foreground();
      assert.equal(typeof fg.process, 'string');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
