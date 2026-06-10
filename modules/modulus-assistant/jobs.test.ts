import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import type { Host } from '../../src/core/modules.js';
import { briefingCron, timeToCron } from './jobs.js';

function makeHost(settings: Record<string, string>): Host {
  return {
    settings: {
      get<T>(key: string, def?: T): T | undefined {
        return (settings[key] as T | undefined) ?? def;
      },
      set() {},
      all: () => settings,
    },
  } as unknown as Host;
}

test('timeToCron validates HH:MM briefing times', () => {
  assert.equal(timeToCron('07:30', '1-5'), '30 7 * * 1-5');
  assert.equal(timeToCron('25:00', '1-5'), null);
  assert.equal(timeToCron('7am', '1-5'), null);
});

test('briefingCron keeps legacy cron only when public time is still default', () => {
  const legacy = makeHost({ morning_cron: '15 6 * * 1-5' });
  assert.equal(briefingCron(legacy, 'morning', '07:00', '1-5'), '15 6 * * 1-5');

  const explicit = makeHost({ morning_time: '08:00', morning_cron: '15 6 * * 1-5' });
  assert.equal(briefingCron(explicit, 'morning', '07:00', '1-5'), '0 8 * * 1-5');
});
