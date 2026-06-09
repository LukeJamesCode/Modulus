import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { matchesCron, nextFireAfter, parseCron } from './cron.js';

test('parseCron accepts star, range, list, step', () => {
  const p = parseCron('*/15 9-17 * * 1-5');
  assert.deepEqual(
    [...p.minute].sort((a, b) => a - b),
    [0, 15, 30, 45],
  );
  assert.deepEqual(
    [...p.hour].sort((a, b) => a - b),
    [9, 10, 11, 12, 13, 14, 15, 16, 17],
  );
  assert.equal(p.dayOfMonth.size, 31);
  assert.equal(p.month.size, 12);
  assert.deepEqual([...p.dayOfWeek].sort(), [1, 2, 3, 4, 5]);
});

test('parseCron rejects malformed input', () => {
  assert.throws(() => parseCron('* * *'));
  assert.throws(() => parseCron('60 * * * *'));
  assert.throws(() => parseCron('* * * * 7'));
  assert.throws(() => parseCron('5-2 * * * *'));
  assert.throws(() => parseCron('*/0 * * * *'));
});

test('matchesCron checks every-5-minute on the right minute', () => {
  const p = parseCron('*/5 * * * *');
  assert.equal(matchesCron(p, new Date(2026, 0, 1, 12, 0)), true);
  assert.equal(matchesCron(p, new Date(2026, 0, 1, 12, 5)), true);
  assert.equal(matchesCron(p, new Date(2026, 0, 1, 12, 7)), false);
});

test('nextFireAfter rolls forward across hours and days', () => {
  const p = parseCron('30 2 * * *');
  const next = nextFireAfter(p, new Date(2026, 4, 1, 5, 0));
  assert.equal(next.getDate(), 2);
  assert.equal(next.getHours(), 2);
  assert.equal(next.getMinutes(), 30);
});

test('nextFireAfter handles weekday constraint', () => {
  // 9am every Monday. Start on a Saturday — next fire is Monday 9am.
  const p = parseCron('0 9 * * 1');
  const sat = new Date(2026, 4, 2, 12, 0); // 2026-05-02 is a Saturday
  const next = nextFireAfter(p, sat);
  assert.equal(next.getDay(), 1);
  assert.equal(next.getHours(), 9);
  assert.equal(next.getMinutes(), 0);
});
