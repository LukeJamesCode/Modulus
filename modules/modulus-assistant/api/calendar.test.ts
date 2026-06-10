import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createCalendarClient } from './calendar.js';

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function makeFetch(responses: Array<unknown | { status: number; body: unknown }>) {
  const calls: Recorded[] = [];
  let i = 0;
  const impl = async (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: init?.headers ?? {},
      body: init?.body,
    });
    const item = responses[i++];
    if (item === undefined) throw new Error('fetch script exhausted');
    const r =
      item && typeof item === 'object' && 'status' in (item as object)
        ? (item as { status: number; body: unknown })
        : { status: 200, body: item };
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      async json() {
        return r.body;
      },
      async text() {
        return typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
      },
    };
  };
  return { impl, calls };
}

const creds = {
  client_id: 'cid',
  client_secret: 'csec',
  refresh_token: 'rtok',
  calendar_id: 'primary',
};

test('listEvents refreshes the access token then GETs the calendar', async () => {
  const fx = makeFetch([
    { access_token: 'AT', expires_in: 3600 },
    {
      items: [
        {
          id: 'e1',
          summary: 'Standup',
          start: { dateTime: '2026-05-01T09:00:00Z' },
          end: { dateTime: '2026-05-01T09:15:00Z' },
        },
      ],
    },
  ]);
  const c = createCalendarClient({ creds, fetchImpl: fx.impl, now: () => 1_000_000_000_000 });
  const events = await c.listEvents({
    timeMin: '2026-05-01T00:00:00Z',
    timeMax: '2026-05-02T00:00:00Z',
  });
  assert.equal(events.length, 1);
  assert.equal(events[0]!.summary, 'Standup');
  assert.equal(fx.calls[0]!.url, 'https://oauth2.googleapis.com/token');
  assert.match(fx.calls[1]!.url, /\/calendars\/primary\/events\?/);
  assert.equal(fx.calls[1]!.headers['authorization'], 'Bearer AT');
});

test('access token is cached and reused inside expiry', async () => {
  const fx = makeFetch([{ access_token: 'AT', expires_in: 3600 }, { items: [] }, { items: [] }]);
  const c = createCalendarClient({ creds, fetchImpl: fx.impl, now: () => 0 });
  await c.listEvents({ timeMin: 'a', timeMax: 'b' });
  await c.listEvents({ timeMin: 'a', timeMax: 'b' });
  assert.equal(fx.calls.filter((c) => c.url.includes('/token')).length, 1);
});

test('addEvent posts ISO start/end and returns the flattened event', async () => {
  const fx = makeFetch([
    { access_token: 'AT', expires_in: 3600 },
    {
      id: 'new',
      summary: 'Lunch',
      start: { dateTime: '2026-05-01T12:00:00Z' },
      end: { dateTime: '2026-05-01T13:00:00Z' },
    },
  ]);
  const c = createCalendarClient({ creds, fetchImpl: fx.impl, now: () => 0 });
  const ev = await c.addEvent({
    summary: 'Lunch',
    start: '2026-05-01T12:00:00Z',
    end: '2026-05-01T13:00:00Z',
  });
  assert.equal(ev.id, 'new');
  const post = fx.calls[1]!;
  assert.equal(post.method, 'POST');
  const sent = JSON.parse(post.body!) as Record<string, unknown>;
  assert.equal((sent['start'] as { dateTime: string }).dateTime, '2026-05-01T12:00:00Z');
});

test('deleteEvent issues DELETE on the right path', async () => {
  const fx = makeFetch([
    { access_token: 'AT', expires_in: 3600 },
    { status: 204, body: '' },
  ]);
  const c = createCalendarClient({ creds, fetchImpl: fx.impl, now: () => 0 });
  await c.deleteEvent('evt-7');
  assert.equal(fx.calls[1]!.method, 'DELETE');
  assert.match(fx.calls[1]!.url, /\/events\/evt-7$/);
});

test('listEvents preserves Google all-day dates without converting through UTC', async () => {
  const fx = makeFetch([
    { access_token: 'AT', expires_in: 3600 },
    {
      items: [
        {
          id: 'all-day',
          summary: "Mya's Grad",
          start: { date: '2026-06-20' },
          end: { date: '2026-06-22' },
        },
      ],
    },
  ]);
  const c = createCalendarClient({ creds, fetchImpl: fx.impl, now: () => 0 });
  const events = await c.listEvents({
    timeMin: '2026-06-20T00:00:00Z',
    timeMax: '2026-06-23T00:00:00Z',
  });
  assert.equal(events[0]!.start, '2026-06-20');
  assert.equal(events[0]!.end, '2026-06-22');
  assert.equal(events[0]!.allDay, true);
});

test('addEvent posts all-day ranges as Google exclusive-end dates', async () => {
  const fx = makeFetch([
    { access_token: 'AT', expires_in: 3600 },
    {
      id: 'grad',
      summary: "Mya's Grad",
      start: { date: '2026-06-20' },
      end: { date: '2026-06-22' },
    },
  ]);
  const c = createCalendarClient({ creds, fetchImpl: fx.impl, now: () => 0 });
  const ev = await c.addEvent({
    summary: "Mya's Grad",
    start: '2026-06-20',
    end: '2026-06-21',
    allDay: true,
  });
  assert.equal(ev.allDay, true);
  const post = fx.calls[1]!;
  const sent = JSON.parse(post.body!) as Record<string, unknown>;
  assert.deepEqual(sent['start'], { date: '2026-06-20' });
  assert.deepEqual(sent['end'], { date: '2026-06-22' });
});
