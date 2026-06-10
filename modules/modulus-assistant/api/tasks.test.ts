import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createTasksClient } from './tasks.js';

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
  default_tasklist: '@default',
};

test('listTasks refreshes token then GETs tasks', async () => {
  const fx = makeFetch([
    { access_token: 'AT', expires_in: 3600 },
    { items: [{ id: 't1', title: 'Buy milk', status: 'needsAction' }] },
  ]);
  const c = createTasksClient({ creds, fetchImpl: fx.impl, now: () => 0 });
  const tasks = await c.listTasks(false);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]!.title, 'Buy milk');
  assert.equal(fx.calls[0]!.url, 'https://oauth2.googleapis.com/token');
  assert.match(fx.calls[1]!.url, /\/lists\/%40default\/tasks/);
});

test('addTask posts the title and returns the flattened task', async () => {
  const fx = makeFetch([
    { access_token: 'AT', expires_in: 3600 },
    { status: 200, body: { id: 'new1', title: 'Write tests', status: 'needsAction' } },
  ]);
  const c = createTasksClient({ creds, fetchImpl: fx.impl, now: () => 0 });
  const t = await c.addTask({ title: 'Write tests' });
  assert.equal(t.id, 'new1');
  assert.equal(fx.calls[1]!.method, 'POST');
  const sent = JSON.parse(fx.calls[1]!.body!) as { title: string };
  assert.equal(sent.title, 'Write tests');
});

test('completeTask PATCHes status to completed', async () => {
  const fx = makeFetch([
    { access_token: 'AT', expires_in: 3600 },
    {
      status: 200,
      body: { id: 't1', title: 'Buy milk', status: 'completed', completed: '2026-05-01T10:00:00Z' },
    },
  ]);
  const c = createTasksClient({ creds, fetchImpl: fx.impl, now: () => 0 });
  const t = await c.completeTask('t1');
  assert.equal(t.status, 'completed');
  assert.equal(fx.calls[1]!.method, 'PATCH');
  assert.match(fx.calls[1]!.url, /\/tasks\/t1$/);
});

test('listTasks follows nextPageToken and combines pages', async () => {
  const fx = makeFetch([
    { access_token: 'AT', expires_in: 3600 },
    { items: [{ id: 't1', title: 'A', status: 'needsAction' }], nextPageToken: 'p2' },
    { items: [{ id: 't2', title: 'B', status: 'needsAction' }] },
  ]);
  const c = createTasksClient({ creds, fetchImpl: fx.impl, now: () => 0 });
  const tasks = await c.listTasks(false);
  assert.equal(tasks.length, 2);
  assert.equal(tasks[1]!.title, 'B');
  assert.match(fx.calls[2]!.url, /pageToken=p2/);
});

test('deleteTask issues DELETE on the correct path', async () => {
  const fx = makeFetch([
    { access_token: 'AT', expires_in: 3600 },
    { status: 204, body: '' },
  ]);
  const c = createTasksClient({ creds, fetchImpl: fx.impl, now: () => 0 });
  await c.deleteTask('t2');
  assert.equal(fx.calls[1]!.method, 'DELETE');
  assert.match(fx.calls[1]!.url, /\/tasks\/t2$/);
});
