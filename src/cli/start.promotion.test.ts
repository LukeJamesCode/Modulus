// Promotion loop: runSetupAndPromote re-enters setup when the full-daemon boot
// throws, carrying the error forward so the wizard can banner it, and stops once
// the boot succeeds. We stub all three injected deps so nothing real boots.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runSetupAndPromote } from './start.js';
import type { SetupServer } from './setup-mode.js';

function fakeSetupServer(): SetupServer {
  return {
    handle: { url: 'http://127.0.0.1:0/?token=t', token: 't', close: async () => {} },
    completed: Promise.resolve(),
    db: {} as SetupServer['db'],
    close: async () => {},
  };
}

test('re-enters setup with the error on a failed boot, then succeeds', async () => {
  const home = mkdtempSync(join(tmpdir(), 'modulus-promote-'));
  try {
    const errorsSeen: Array<string | null> = [];
    let boots = 0;
    let bootCalls = 0;
    let openCalls = 0;

    await runSetupAndPromote(
      home,
      {},
      {
        startSetupServer: async (_home, opts) => {
          boots += 1;
          errorsSeen.push(opts.lastError ?? null);
          return fakeSetupServer();
        },
        bootDaemon: async () => {
          bootCalls += 1;
          if (bootCalls === 1) throw new Error('boot failed once');
          // second call succeeds
        },
        openBrowser: () => {
          openCalls += 1;
          return true;
        },
      },
    );

    // Two setup boots: the first attempt failed, so we re-entered.
    assert.equal(boots, 2);
    // First boot had no prior error; the second received the boot failure.
    assert.equal(errorsSeen[0], null);
    assert.match(errorsSeen[1] ?? '', /boot failed once/);
    // bootDaemon was attempted twice (fail then succeed).
    assert.equal(bootCalls, 2);
    // Browser auto-open is gated on a TTY; the test runner has none, so it
    // never fired regardless of the injected stub.
    assert.equal(openCalls, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
