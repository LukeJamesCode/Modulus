// First-run gate for the panel. app.jsx shows the onboarding wizard when
// /api/state reports `configured: false` and the main hub once it's true, so
// buildState's `configured` flag IS the wizard trigger. These tests pin that
// contract: a fresh install must land in the wizard, and it only graduates to
// the hub once there's both a bot token AND someone allowed to talk to it — a
// token with no allowed id can't actually chat, so it must not count as set up.
// They also pin that tier detection is always present, which the wizard's
// Hardware step pre-selects from.

import { test, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open, type DB } from '../storage/db.js';
import { createLogger } from '../util/log.js';
import { saveConfig, effectiveConfig } from '../cli/config-store.js';
import { buildState } from './state.js';

interface StateView {
  configured: boolean;
  suggestedTier: string;
  ramGb: number;
  allowlistCount: number;
  setupMode: boolean;
  setupError: string | null;
  modelRecommendations: Record<string, { chat: string; approxSize: string }>;
}

// effectiveConfig() overlays TELEGRAM_* env vars over the file, which would make
// the "fresh install" cases non-hermetic if the dev box has them set. Snapshot
// and clear them for the suite, restore after.
let savedToken: string | undefined;
let savedIds: string | undefined;
before(() => {
  savedToken = process.env['TELEGRAM_BOT_TOKEN'];
  savedIds = process.env['TELEGRAM_ALLOWED_IDS'];
  delete process.env['TELEGRAM_BOT_TOKEN'];
  delete process.env['TELEGRAM_ALLOWED_IDS'];
});
after(() => {
  if (savedToken !== undefined) process.env['TELEGRAM_BOT_TOKEN'] = savedToken;
  if (savedIds !== undefined) process.env['TELEGRAM_ALLOWED_IDS'] = savedIds;
});

function setup(): { home: string; db: DB; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'modulus-state-'));
  const db = open({ path: join(home, 'modulus.db'), log: createLogger({ level: 'error' }) });
  return {
    home,
    db,
    cleanup() {
      db.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

async function state(
  home: string,
  db: DB,
  extra: { setupMode?: boolean; setupError?: string | null } = {},
): Promise<StateView> {
  return (await buildState({
    db,
    home,
    moduleRoots: [],
    proactive: false,
    ...extra,
  })) as StateView;
}

test('buildState: a fresh install is not configured (panel opens the wizard)', async () => {
  const { home, db, cleanup } = setup();
  try {
    const s = await state(home, db);
    assert.equal(s.configured, false);
    // Tier detection is always present so the wizard's Hardware step can preselect.
    assert.ok(['small', 'standard', 'heavy'].includes(s.suggestedTier));
    assert.ok(typeof s.ramGb === 'number' && s.ramGb > 0);
  } finally {
    cleanup();
  }
});

test('buildState: a bot token + an allowed id flips configured (panel opens the hub)', async () => {
  const { home, db, cleanup } = setup();
  try {
    saveConfig(
      { ...effectiveConfig(home), telegram: { token: 'bot-token', allowedIds: [123] } },
      home,
    );
    const s = await state(home, db);
    assert.equal(s.configured, true);
    assert.equal(s.allowlistCount, 1);
  } finally {
    cleanup();
  }
});

test('buildState: a token with no allowed ids stays in the wizard', async () => {
  const { home, db, cleanup } = setup();
  try {
    saveConfig(
      { ...effectiveConfig(home), telegram: { token: 'bot-token', allowedIds: [] } },
      home,
    );
    const s = await state(home, db);
    assert.equal(s.configured, false);
  } finally {
    cleanup();
  }
});

test('buildState: a panel-only install (config saved, no Telegram) is configured', async () => {
  const { home, db, cleanup } = setup();
  try {
    // A finished wizard writes config.json with a chat model but no bot token —
    // Telegram is optional, so this is configured and the panel opens the hub.
    saveConfig({ ...effectiveConfig(home), telegram: { token: '', allowedIds: [] } }, home);
    const s = await state(home, db);
    assert.equal(s.configured, true);
    assert.equal(s.allowlistCount, 0);
  } finally {
    cleanup();
  }
});

test('buildState: setupMode + setupError pass through, recommendations are always present', async () => {
  const { home, db, cleanup } = setup();
  try {
    // Default (full mode): setupMode false, no error.
    const off = await state(home, db);
    assert.equal(off.setupMode, false);
    assert.equal(off.setupError, null);
    // Recommendations cover every tier with a chat tag + an approx size.
    for (const tier of ['small', 'standard', 'heavy']) {
      const rec = off.modelRecommendations[tier];
      assert.ok(rec && typeof rec.chat === 'string' && rec.chat.length > 0, `${tier} chat tag`);
      assert.ok(typeof rec.approxSize === 'string', `${tier} approx size`);
    }
    // Setup mode with a prior failed-boot message.
    const on = await state(home, db, { setupMode: true, setupError: 'boom' });
    assert.equal(on.setupMode, true);
    assert.equal(on.setupError, 'boom');
  } finally {
    cleanup();
  }
});
