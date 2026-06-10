// Smoke tests for the two briefing tools (briefing_today, briefing_tomorrow).
// Tests that buildMorningBrief / buildNightBrief return non-empty strings even
// without any credentials configured — all sub-gatherers have their own
// try/catch so a cold install never crashes the briefing.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../../../src/storage/db.js';
import type { Host } from '../../../src/core/modules.js';
import { buildMorningBrief, buildNightBrief } from '../gather.js';

function makeEmptyHost(db: ReturnType<typeof open>): Host {
  return {
    settings: {
      get<T>(_key: string, def?: T): T | undefined {
        return def;
      },
      set() {},
    },
    db,
    telegram: {
      knownChats: () => [],
      defaultChatId: null,
    },
  } as unknown as Host;
}

test('buildMorningBrief returns a non-empty string with no credentials', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ged-briefing-'));
  try {
    const db = open({ path: join(tmp, 'g.db') });
    const host = makeEmptyHost(db);
    const brief = await buildMorningBrief(host);
    assert.ok(typeof brief === 'string' && brief.length > 0, 'brief should be non-empty');
    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('buildNightBrief returns a non-empty string with no credentials', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ged-nightbrief-'));
  try {
    const db = open({ path: join(tmp, 'g.db') });
    const host = makeEmptyHost(db);
    const brief = await buildNightBrief(host);
    assert.ok(typeof brief === 'string' && brief.length > 0, 'night brief should be non-empty');
    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
