import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { dateRangeToday, dateRangeTomorrow } from './range.js';

test('dateRangeToday builds midnight bounds in the briefing timezone', () => {
  const range = dateRangeToday('America/Edmonton', new Date('2026-05-08T18:00:00Z'));
  assert.deepEqual(range, {
    timeMin: '2026-05-08T06:00:00.000Z',
    timeMax: '2026-05-09T06:00:00.000Z',
  });
});

test('dateRangeTomorrow builds the next local calendar day in positive offset zones', () => {
  const range = dateRangeTomorrow('Pacific/Kiritimati', new Date('2026-05-08T18:00:00Z'));
  assert.deepEqual(range, {
    timeMin: '2026-05-09T10:00:00.000Z',
    timeMax: '2026-05-10T10:00:00.000Z',
  });
});
