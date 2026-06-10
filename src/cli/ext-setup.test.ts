import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open as openDb } from '../storage/db.js';
import { createLogger } from '../util/log.js';
import { setupModule, type DiscoveredModule } from './ext-setup.js';

test('setupModule runs optional module setup entrypoint', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'modulus-ext-setup-'));
  try {
    const folder = join(dir, 'demo');
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, 'setup.js'),
      [
        'export async function setup(ctx) {',
        "  ctx.stdout('setup ran\\n');",
        "  ctx.settings.set('native_ready', true);",
        '}',
      ].join('\n'),
    );
    const mod: DiscoveredModule = {
      name: 'demo',
      folder,
      manifest: {
        name: 'demo',
        version: '0.1.0',
        modulus: '*',
        entrypoints: { setup: './setup.js' },
      },
    };
    const db = openDb({
      path: join(dir, 'modulus.db'),
      log: createLogger({ level: 'error', out: () => {}, err: () => {} }),
    });
    try {
      await setupModule(mod, db, dir);
      const row = db
        .prepare(`SELECT value FROM module_settings WHERE module = ? AND key = ?`)
        .get('demo', 'native_ready') as { value: string } | undefined;
      assert.equal(row?.value, 'true');
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
