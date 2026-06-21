// The deterministic "today's calendar" route must claim ONLY canonical,
// single-intent, read-only questions — and decline anything that names another
// day, carries a second intent, or asks to change the calendar — so it never
// hijacks a turn the model should handle. The anchored full-string match is the
// safety property under test.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { calendarTodayAutoRoute } from './calendar.js';

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
    assert.deepEqual(calendarTodayAutoRoute(m), {}, `should claim: ${m}`);
  }
});

test('declines anything ambiguous, compound, or write-intent', () => {
  const decline = [
    'what do i have tomorrow', // another day → model resolves the date
    'am i free thursday afternoon',
    "what's on my calendar today and remind me to call mom", // compound
    'add an event today at 3pm', // write intent
    'cancel my dentist today',
    'move my 3pm to today',
    "what's the weather today", // not calendar
    'today was a good day', // not a question
    'schedule lunch today 1pm',
  ];
  for (const m of decline) {
    assert.equal(calendarTodayAutoRoute(m), null, `should decline: ${m}`);
  }
});
