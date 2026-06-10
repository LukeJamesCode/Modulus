import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseReminderTime, splitReminderArgs } from './time.js';

const BASE = new Date('2026-05-01T10:00:00');

test('parseReminderTime: ISO 8601 string', () => {
  const d = parseReminderTime('2026-05-01T15:00:00', BASE);
  assert.ok(d);
  assert.equal(d!.getHours(), 15);
  assert.equal(d!.getDate(), 1);
});

test('parseReminderTime: "in N minutes"', () => {
  const d = parseReminderTime('in 30 minutes', BASE);
  assert.ok(d);
  assert.equal(d!.getMinutes(), 30);
});

test('parseReminderTime: "in N hours"', () => {
  const d = parseReminderTime('in 2 hours', BASE);
  assert.ok(d);
  assert.equal(d!.getHours(), 12);
});

test('parseReminderTime: "in N days"', () => {
  const d = parseReminderTime('in 3 days', BASE);
  assert.ok(d);
  assert.equal(d!.getDate(), 4);
});

test('parseReminderTime: "tomorrow at 9am"', () => {
  const d = parseReminderTime('tomorrow at 9am', BASE);
  assert.ok(d);
  assert.equal(d!.getDate(), 2);
  assert.equal(d!.getHours(), 9);
});

test('parseReminderTime: "tomorrow at 3:30pm"', () => {
  const d = parseReminderTime('tomorrow at 3:30pm', BASE);
  assert.ok(d);
  assert.equal(d!.getHours(), 15);
  assert.equal(d!.getMinutes(), 30);
});

test('parseReminderTime: "at 3pm" — future', () => {
  const d = parseReminderTime('at 3pm', BASE);
  assert.ok(d);
  assert.equal(d!.getHours(), 15);
  assert.equal(d!.getDate(), 1);
});

test('parseReminderTime: "at 8am" — already past rolls to tomorrow', () => {
  const d = parseReminderTime('at 8am', BASE);
  assert.ok(d);
  assert.equal(d!.getDate(), 2);
  assert.equal(d!.getHours(), 8);
});

test('parseReminderTime: unrecognised input returns null', () => {
  assert.equal(parseReminderTime('next week sometime', BASE), null);
  assert.equal(parseReminderTime('', BASE), null);
});

test('parseReminderTime: rejects out-of-range hour', () => {
  assert.equal(parseReminderTime('at 25:00', BASE), null);
  assert.equal(parseReminderTime('tomorrow at 25:00', BASE), null);
});

test('parseReminderTime: rejects out-of-range minute', () => {
  assert.equal(parseReminderTime('at 9:99', BASE), null);
  assert.equal(parseReminderTime('tomorrow at 9:60', BASE), null);
});

test('parseReminderTime: rejects 13pm / 0pm', () => {
  assert.equal(parseReminderTime('at 13pm', BASE), null);
  assert.equal(parseReminderTime('at 0pm', BASE), null);
});

test('splitReminderArgs: "in 30 minutes Call doctor"', () => {
  const r = splitReminderArgs('in 30 minutes Call doctor');
  assert.ok(r);
  assert.equal(r!.timeStr, 'in 30 minutes');
  assert.equal(r!.message, 'Call doctor');
});

test('splitReminderArgs: "tomorrow at 9am Stand-up"', () => {
  const r = splitReminderArgs('tomorrow at 9am Stand-up');
  assert.ok(r);
  assert.equal(r!.message, 'Stand-up');
});

test('splitReminderArgs: "at 3pm Review PR"', () => {
  const r = splitReminderArgs('at 3pm Review PR');
  assert.ok(r);
  assert.equal(r!.timeStr.toLowerCase(), 'at 3pm');
  assert.equal(r!.message, 'Review PR');
});

test('splitReminderArgs: no recognisable pattern returns null', () => {
  assert.equal(splitReminderArgs('just remind me'), null);
});
