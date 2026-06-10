import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { formatEventLine, hasClockTime } from './calendar.js';

test('formatEventLine renders multi-day all-day events without clock times', () => {
  const line = formatEventLine({
    id: 'grad',
    summary: "Mya's Grad",
    start: '2026-06-20',
    end: '2026-06-22',
    allDay: true,
  });
  assert.match(line, /All day/);
  assert.match(line, /Mya's Grad/);
  assert.doesNotMatch(line, /\d{1,2}:\d{2}/);
  assert.doesNotMatch(line, /May 7/);
});

test('formatEventLine keeps Google Calendar offset wall-clock time', () => {
  const line = formatEventLine({
    id: 'school',
    summary: 'School',
    start: '2026-05-08T08:55:00-06:00',
    end: '2026-05-08T23:50:00-06:00',
  });
  // Check hour values without asserting on locale-specific AM/PM capitalisation.
  assert.match(line, /08:55/);
  assert.match(line, /11:50/);
  assert.match(line, /School/);
  // UTC equivalent of 08:55-06:00 is 14:55; it must NOT appear.
  assert.doesNotMatch(line, /14:55/);
});

test('formatEventLine can render into an explicit briefing timezone', () => {
  const line = formatEventLine(
    {
      id: 'school',
      summary: 'School',
      start: '2026-05-08T14:55:00Z',
      end: '2026-05-09T05:50:00Z',
    },
    { timeZone: 'America/Edmonton' },
  );
  assert.match(line, /08:55/);
  assert.match(line, /11:50/);
});

test('hasClockTime accepts phrases with am/pm, "at H", and idiomatic time words', () => {
  assert.equal(hasClockTime('Lunch with Sam Friday 1pm'), true);
  assert.equal(hasClockTime('Dentist tomorrow at 10am'), true);
  assert.equal(hasClockTime('Team standup tomorrow 9-9:30am'), true);
  assert.equal(hasClockTime('Coffee at 3'), true);
  assert.equal(hasClockTime('Standup at 09:00'), true);
  assert.equal(hasClockTime('Dinner tonight'), true);
  assert.equal(hasClockTime('Lunch tomorrow noon'), true);
});

test('hasClockTime rejects date-only phrases that would silently land on today', () => {
  assert.equal(hasClockTime('grad rehearsal on may 19th'), false);
  assert.equal(hasClockTime('birthday on June 5'), false);
  assert.equal(hasClockTime('graduation June 20 to June 21'), false);
  assert.equal(hasClockTime("Mya's grad next Friday"), false);
});
