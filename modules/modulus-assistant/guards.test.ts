import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import type { AfterTurnToolCallSummary } from '../../src/core/modules.js';
import { fakeActionConfirmationGuard, fakeWeatherAnswerGuard } from './guards.js';

// Build the tool-call summaries a turn guard sees. The guards only read `ok`
// and `name`, but we satisfy the full AfterTurnToolCallSummary so the fixtures
// stay honest about the shape core actually hands them.
function ran(...names: string[]): AfterTurnToolCallSummary[] {
  return names.map((name) => ({ name, arguments: {}, ok: true, resultSummary: '' }));
}

// fakeActionConfirmationGuard catches the "I removed that for you" lie. The
// bot was telling users events/tasks/reminders were gone when nothing had
// actually been deleted in the DB or on the calendar. A non-null return means
// the reply is overwritten with the correction.

test('fake-confirm: model claims removal but no destructive tool ran', () => {
  assert.notEqual(
    fakeActionConfirmationGuard({
      userText: "I don't want to eat pizza anymore remove eating pizza on may 30th",
      assistantText: 'The event for "Eating pizza" on May 30th has been removed.',
      toolCalls: ran('calendar_list_events'),
    }),
    null,
  );
});

test('fake-confirm: model output "Removed event IDs" without any tool call', () => {
  assert.notEqual(
    fakeActionConfirmationGuard({
      userText: 'remove eating pizza on may 30th',
      assistantText: 'Removed event IDs: [14], [15]',
      toolCalls: ran(),
    }),
    null,
  );
});

test('fake-confirm: legitimate run with delete tool is NOT flagged', () => {
  assert.equal(
    fakeActionConfirmationGuard({
      userText: 'cancel my dentist appointment',
      assistantText: 'Cancelled. The dentist appointment is removed.',
      toolCalls: ran('calendar_list_events', 'calendar_delete_event'),
    }),
    null,
  );
});

test('fake-confirm: user did not ask to delete — not a hallucination', () => {
  assert.equal(
    fakeActionConfirmationGuard({
      userText: 'what events do I have today',
      assistantText: 'You have a meeting at 3pm.',
      toolCalls: ran('calendar_list_events'),
    }),
    null,
  );
});

test('fake-confirm: delete intent but assistant did not claim completion', () => {
  assert.equal(
    fakeActionConfirmationGuard({
      userText: 'cancel my dentist',
      assistantText: 'I need the event id — try `/reminders` first.',
      toolCalls: ran(),
    }),
    null,
  );
});

test('fake-confirm: reminder_clear_all counts as a destructive tool', () => {
  assert.equal(
    fakeActionConfirmationGuard({
      userText: 'get rid of all my reminders',
      assistantText: 'Cleared 3 reminders.',
      toolCalls: ran('reminder_clear_all'),
    }),
    null,
  );
});

// fakeWeatherAnswerGuard catches the "let me invent a forecast" lie.

test('fake-weather: forecast answer with temperatures and no weather tool', () => {
  assert.notEqual(
    fakeWeatherAnswerGuard({
      userText: "What's the forecast for the next few days?",
      assistantText:
        '* May 24th: Overcast, 14–22°C, 57% precip.\n* May 25th: Partly cloudy, 17–26°C.',
      toolCalls: ran(),
    }),
    null,
  );
});

test('fake-weather: "will it rain" with chance-of-rain reply and no tool', () => {
  assert.notEqual(
    fakeWeatherAnswerGuard({
      userText: 'Will it rain tomorrow?',
      assistantText: 'Yes — there is a 40% chance of rain in the afternoon.',
      toolCalls: ran(),
    }),
    null,
  );
});

test('fake-weather: legitimate weather_get call is NOT flagged', () => {
  assert.equal(
    fakeWeatherAnswerGuard({
      userText: "What's the weather?",
      assistantText: 'Calgary: 18°C, clear sky.',
      toolCalls: ran('weather_get'),
    }),
    null,
  );
});

test('fake-weather: non-weather question is NOT flagged', () => {
  assert.equal(
    fakeWeatherAnswerGuard({
      userText: "what's on my calendar today",
      assistantText: 'You have a meeting at 3pm.',
      toolCalls: ran('calendar_list_events'),
    }),
    null,
  );
});

test('fake-weather: weather question answered with no forecast claim is NOT flagged', () => {
  // Model legitimately declined or asked a clarifying question — no
  // hallucinated temperatures, so this is fine.
  assert.equal(
    fakeWeatherAnswerGuard({
      userText: "What's the weather?",
      assistantText: 'Which city should I check?',
      toolCalls: ran(),
    }),
    null,
  );
});
