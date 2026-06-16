import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseSchedule, describeSpec, hostTimeZone } from './schedule-parse.js';
import type { ScheduleSpec } from './schedule-parse.js';
import type { LLM, ChatChunk, ChatOptions } from './llm.js';

// Fixed reference instant: Monday 2026-06-15 12:00 in America/Denver (MDT,
// UTC-6) → 18:00 UTC. Every relative/wall-clock assertion below is anchored to
// this, so the tests are deterministic regardless of the machine's own zone.
const TZ = 'America/Denver';
const NOW = new Date('2026-06-15T18:00:00Z');

function ctx(extra: Partial<{ llm: LLM }> = {}) {
  return { now: NOW, timeZone: TZ, ...extra };
}

// A FakeLLM whose single completion is the supplied reply. `calls` lets a test
// assert whether the rules pass short-circuited the model.
function fakeLlm(reply: string): LLM & { calls: ChatOptions[] } {
  const calls: ChatOptions[] = [];
  async function* one(): AsyncIterable<ChatChunk> {
    yield { delta: reply, done: true, model: 'fake' };
  }
  const llm: LLM = {
    chat(opts) {
      calls.push(opts);
      return one();
    },
    async health() {
      return { ok: true, models: ['fake'] };
    },
    listProfiles() {
      return {
        chat: { model: 'fake', contextTokens: 4096, heavy: false },
        reason: null,
        tools: { model: 'fake', contextTokens: 4096, heavy: false },
      };
    },
    resolveModel: () => 'fake',
    breakerSnapshot: () => ({
      state: 'closed',
      failures: 0,
      consecutiveSuccesses: 0,
      openedAt: null,
      retryAt: null,
    }),
    stopIdleEviction: () => {},
  };
  return Object.assign(llm, { calls });
}

function asRecurring(spec: ScheduleSpec): { cron: string; timeZone: string } {
  assert.ok(!('error' in spec), `expected recurring, got error: ${JSON.stringify(spec)}`);
  assert.equal(spec.kind, 'recurring');
  return spec as { kind: 'recurring'; cron: string; timeZone: string };
}

function asOnce(spec: ScheduleSpec): number {
  assert.ok(!('error' in spec), `expected once, got error: ${JSON.stringify(spec)}`);
  assert.equal(spec.kind, 'once');
  return (spec as { kind: 'once'; at: number }).at;
}

// Wall-clock fields of an epoch, read back in TZ — for asserting once-times.
function wall(at: number) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    hourCycle: 'h23',
    weekday: 'short',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(at));
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return { weekday: g('weekday'), day: g('day'), hour: g('hour'), minute: g('minute') };
}

// ---- relative one-shots ---------------------------------------------------

test('"in 20 minutes" → once, no model call', async () => {
  const llm = fakeLlm('NONE');
  const spec = await parseSchedule('in 20 minutes', ctx({ llm }));
  assert.equal(asOnce(spec), NOW.getTime() + 20 * 60_000);
  assert.equal(llm.calls.length, 0, 'rules must not consult the model');
});

test('"in an hour" → +1h', async () => {
  assert.equal(asOnce(await parseSchedule('in an hour', ctx())), NOW.getTime() + 3_600_000);
});

test('"in 2 hours" → +2h', async () => {
  assert.equal(asOnce(await parseSchedule('in 2 hours', ctx())), NOW.getTime() + 2 * 3_600_000);
});

// ---- recurring ------------------------------------------------------------

test('"every day at 8am" → 0 8 * * *', async () => {
  assert.equal(asRecurring(await parseSchedule('every day at 8am', ctx())).cron, '0 8 * * *');
});

test('"every weekday at 8am" → 0 8 * * 1-5', async () => {
  assert.equal(asRecurring(await parseSchedule('every weekday at 8am', ctx())).cron, '0 8 * * 1-5');
});

test('"every weekend at 10" → 0 10 * * 0,6', async () => {
  assert.equal(asRecurring(await parseSchedule('every weekend at 10', ctx())).cron, '0 10 * * 0,6');
});

test('"every Monday at 9" → 0 9 * * 1', async () => {
  assert.equal(asRecurring(await parseSchedule('every Monday at 9', ctx())).cron, '0 9 * * 1');
});

test('"every mon and wed at 7:30" → 30 7 * * 1,3', async () => {
  assert.equal(asRecurring(await parseSchedule('every mon and wed at 7:30', ctx())).cron, '30 7 * * 1,3');
});

test('"every 2 hours" → 0 */2 * * *', async () => {
  assert.equal(asRecurring(await parseSchedule('every 2 hours', ctx())).cron, '0 */2 * * *');
});

test('"every 30 minutes" → */30 * * * *', async () => {
  assert.equal(asRecurring(await parseSchedule('every 30 minutes', ctx())).cron, '*/30 * * * *');
});

test('"hourly" → 0 * * * *', async () => {
  assert.equal(asRecurring(await parseSchedule('hourly', ctx())).cron, '0 * * * *');
});

test('"every 90 minutes" is rejected, not silently collapsed to hourly', async () => {
  assert.ok('error' in (await parseSchedule('every 90 minutes', ctx())));
});

test('"every 25 hours" is rejected, not silently collapsed to daily', async () => {
  assert.ok('error' in (await parseSchedule('every 25 hours', ctx())));
});

test('"every 120 minutes" → every 2 hours (0 */2 * * *)', async () => {
  assert.equal(asRecurring(await parseSchedule('every 120 minutes', ctx())).cron, '0 */2 * * *');
});

test('"every 24 hours" → daily (0 0 * * *)', async () => {
  assert.equal(asRecurring(await parseSchedule('every 24 hours', ctx())).cron, '0 0 * * *');
});

test('"monthly on the 1st at noon" → 0 12 1 * *', async () => {
  assert.equal(asRecurring(await parseSchedule('monthly on the 1st at noon', ctx())).cron, '0 12 1 * *');
});

test('"on the 15th at 9am" → 0 9 15 * * (monthly)', async () => {
  assert.equal(asRecurring(await parseSchedule('on the 15th at 9am', ctx())).cron, '0 9 15 * *');
});

test('recurring carries the time zone through', async () => {
  assert.equal(asRecurring(await parseSchedule('every day at 8am', ctx())).timeZone, TZ);
});

// ---- dated one-shots ------------------------------------------------------

test('"tomorrow at 5pm" → next day 17:00', async () => {
  const w = wall(asOnce(await parseSchedule('tomorrow at 5pm', ctx())));
  assert.equal(w.day, '16');
  assert.equal(w.hour, '17');
  assert.equal(w.minute, '00');
});

test('"tomorrow" with no time defaults to 09:00', async () => {
  const w = wall(asOnce(await parseSchedule('tomorrow', ctx())));
  assert.equal(w.day, '16');
  assert.equal(w.hour, '09');
});

test('bare "9am" already past today rolls to tomorrow', async () => {
  const w = wall(asOnce(await parseSchedule('9am', ctx())));
  assert.equal(w.day, '16');
  assert.equal(w.hour, '09');
});

test('bare "5pm" still ahead lands today', async () => {
  const w = wall(asOnce(await parseSchedule('5pm', ctx())));
  assert.equal(w.day, '15');
  assert.equal(w.hour, '17');
});

test('"today at 9am" in the past is rejected, not silently rolled', async () => {
  const spec = await parseSchedule('today at 9am', ctx());
  assert.ok('error' in spec);
});

// ---- model fallback -------------------------------------------------------

test('a novel phrasing falls through to the model (cron JSON)', async () => {
  const llm = fakeLlm('{"cron":"15 6 * * 1-5"}');
  const spec = await parseSchedule('on workday mornings a quarter past six', ctx({ llm }));
  assert.equal(asRecurring(spec).cron, '15 6 * * 1-5');
  assert.equal(llm.calls.length, 1, 'novel phrasing must escalate to the model');
});

test('model once JSON is resolved in the user zone', async () => {
  const llm = fakeLlm('{"once":"2026-06-20T17:00"}');
  const w = wall(asOnce(await parseSchedule('the evening of the solstice party', ctx({ llm }))));
  assert.equal(w.day, '20');
  assert.equal(w.hour, '17');
});

test('a hallucinated cron from the model is rejected', async () => {
  const llm = fakeLlm('{"cron":"99 99 * * *"}');
  const spec = await parseSchedule('whenever the stars align', ctx({ llm }));
  assert.ok('error' in spec);
});

test('a model past-time once is rejected', async () => {
  const llm = fakeLlm('{"once":"2020-01-01T09:00"}');
  const spec = await parseSchedule('back when', ctx({ llm }));
  assert.ok('error' in spec);
});

// ---- guards ---------------------------------------------------------------

test('empty input is an error', async () => {
  assert.ok('error' in (await parseSchedule('   ', ctx())));
});

test('unparseable with no model is an error', async () => {
  assert.ok('error' in (await parseSchedule('banana pancakes', ctx())));
});

test('describeSpec renders a recurring cron and a once time', () => {
  assert.match(describeSpec({ kind: 'recurring', cron: '0 8 * * *', timeZone: TZ }, TZ), /0 8 \* \* \*/);
  assert.ok(describeSpec({ kind: 'once', at: NOW.getTime() }, TZ).length > 0);
});

test('hostTimeZone returns a non-empty string', () => {
  assert.ok(hostTimeZone().length > 0);
});
