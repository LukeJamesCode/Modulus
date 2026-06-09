import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearPid, isAlive, pidFilePath, readPid, writePid } from './daemon.js';

function mkHome(): string {
  return mkdtempSync(join(tmpdir(), 'modulus-daemon-test-'));
}

test('writePid + readPid round-trip', () => {
  const home = mkHome();
  try {
    writePid(4242, home);
    assert.equal(readPid(home), 4242);
    assert.ok(existsSync(pidFilePath(home)));
    assert.equal(readFileSync(pidFilePath(home), 'utf8'), '4242');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('readPid returns null when file missing', () => {
  const home = mkHome();
  try {
    assert.equal(readPid(home), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('clearPid removes the file (or no-ops if missing)', () => {
  const home = mkHome();
  try {
    clearPid(home); // should not throw
    writePid(7, home);
    clearPid(home);
    assert.equal(existsSync(pidFilePath(home)), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('isAlive returns true for current process and false for absurd pid', () => {
  assert.equal(isAlive(process.pid), true);
  // PIDs > 2^22 are not used by Linux; this is a portable not-alive choice.
  assert.equal(isAlive(99999999), false);
});
