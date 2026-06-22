// The deterministic day-agenda route must claim ONLY canonical, single-intent,
// read-only "today"/"tomorrow" questions — and decline anything that names some
// other day, carries a second intent, or asks to change the calendar — so it
// never hijacks a turn the model should handle. The anchored full-string match
// is the safety property under test. "tomorrow" resolves its date in code (the
// 2B model can't be trusted to), so those claims carry a concrete `date`.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { calendarRelativeDayAutoRoute } from './calendar.js';

test('claims the canonical today-calendar questions (0-LLM read)', () => {
  const claim = [
    "what's on my calendar today",
    'what is on my calendar',
    "what's on today",
    'what do i have today',
    'do i have anything today',
    'am i free today',
    'my agenda for today',
    "today's events",
    'What’s on my calendar today?',
  ];
  for (const m of claim) {
    assert.deepEqual(calendarRelativeDayAutoRoute(m), {}, `should claim today: ${m}`);
  }
});

test('claims canonical tomorrow questions and resolves the date in code', () => {
  // 2026-06-21 12:00 local → tomorrow is 2026-06-22 regardless of host zone
  // (noon avoids any midnight/DST edge). Assert the resolved date, not just {}.
  const now = new Date(2026, 5, 21, 12, 0, 0);
  const claim = [
    "what's on my calendar tomorrow",
    'what is on tomorrow',
    'what do i have tomorrow',
    'what do i have on my calendar tomorrow',
    'do i have anything tomorrow',
    'am i free tomorrow',
    'my agenda for tomorrow',
    "tomorrow's events",
    // Common misspellings must still route (the failing real-world message).
    'what do i have on my calendar tommorow?',
    'whats on my calendar tomorow',
  ];
  for (const m of claim) {
    assert.deepEqual(
      calendarRelativeDayAutoRoute(m, now),
      { date: '2026-06-22' },
      `should claim tomorrow: ${m}`,
    );
  }
});

test('resolves tomorrow in the configured timezone', () => {
  // 2026-06-21 23:30 in America/New_York is still 2026-06-21 there, so tomorrow
  // is 2026-06-22 — even though the same instant is already 2026-06-22 in UTC.
  const lateNight = new Date('2026-06-22T03:30:00Z'); // 23:30 EDT on the 21st
  assert.deepEqual(
    calendarRelativeDayAutoRoute('what do i have tomorrow', lateNight, 'America/New_York'),
    { date: '2026-06-22' },
  );
});

test('declines anything ambiguous, compound, or write-intent', () => {
  const decline = [
    'am i free thursday afternoon', // a named weekday → model resolves the date
    "what's on my calendar today and remind me to call mom", // compound
    'what do i have tomorrow and the day after', // compound
    'add an event today at 3pm', // write intent
    'add an event tomorrow at 3pm',
    'cancel my dentist today',
    'move my 3pm to tomorrow',
    "what's the weather today", // not calendar
    'today was a good day', // not a question
    'schedule lunch today 1pm',
  ];
  for (const m of decline) {
    assert.equal(calendarRelativeDayAutoRoute(m), null, `should decline: ${m}`);
  }
});
