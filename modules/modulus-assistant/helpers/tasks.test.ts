import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  findTaskByTitle,
  formatTask,
  friendlyTaskError,
  normalizeDue,
  todayLocalIsoDate,
} from './tasks.js';
import { TasksApiError, type Task, type TasksClient } from '../api/tasks.js';

test('formatTask hides id by default and uses an ISO date', () => {
  const out = formatTask({
    id: 'abc',
    title: 'Buy milk',
    due: '2026-05-09T00:00:00.000Z',
  });
  assert.equal(out, 'Buy milk (due 2026-05-09)');
});

test('formatTask appends an [id:...] tag when includeId is set', () => {
  const out = formatTask({ id: 'abc', title: 'Buy milk' }, { includeId: true });
  assert.equal(out, 'Buy milk  [id:abc]');
});

test('normalizeDue accepts plain YYYY-MM-DD and turns it into midnight UTC', () => {
  assert.equal(normalizeDue('2026-05-09'), '2026-05-09T00:00:00.000Z');
});

test('normalizeDue passes a full ISO string through to the same instant', () => {
  assert.equal(normalizeDue('2026-05-09T15:30:00Z'), '2026-05-09T15:30:00.000Z');
});

test('normalizeDue throws a clear error on bad input', () => {
  assert.throws(() => normalizeDue('next Friday'), /invalid due date/);
  assert.throws(() => normalizeDue(''), /empty/);
});

test('todayLocalIsoDate renders the injected date in local YYYY-MM-DD form', () => {
  const d = new Date(2026, 4, 11, 12, 0, 0);
  assert.equal(todayLocalIsoDate(d), '2026-05-11');
});

function fakeClient(tasks: Task[]): TasksClient {
  return {
    async listTasks() {
      return tasks;
    },
    async listTaskLists() {
      return [];
    },
    async addTask() {
      throw new Error('not used');
    },
    async completeTask() {
      throw new Error('not used');
    },
    async deleteTask() {
      // not used
    },
  } as unknown as TasksClient;
}

test('findTaskByTitle returns one when an exact match exists', async () => {
  const client = fakeClient([
    { id: '1', title: 'Buy milk', status: 'needsAction' },
    { id: '2', title: 'Buy milk for tomorrow', status: 'needsAction' },
  ]);
  const m = await findTaskByTitle(client, 'buy milk');
  assert.equal(m.kind, 'one');
  if (m.kind === 'one') assert.equal(m.task.id, '1');
});

test('findTaskByTitle falls back to substring when no exact match', async () => {
  const client = fakeClient([
    { id: '1', title: 'Submit Q2 report', status: 'needsAction' },
    { id: '2', title: 'Email Bob', status: 'needsAction' },
  ]);
  const m = await findTaskByTitle(client, 'Q2');
  assert.equal(m.kind, 'one');
  if (m.kind === 'one') assert.equal(m.task.id, '1');
});

test('findTaskByTitle reports many when ambiguous', async () => {
  const client = fakeClient([
    { id: '1', title: 'Email Bob', status: 'needsAction' },
    { id: '2', title: 'Email Alice', status: 'needsAction' },
  ]);
  const m = await findTaskByTitle(client, 'email');
  assert.equal(m.kind, 'many');
  if (m.kind === 'many') assert.equal(m.matches.length, 2);
});

test('findTaskByTitle reports none when nothing matches', async () => {
  const client = fakeClient([{ id: '1', title: 'Buy milk', status: 'needsAction' }]);
  const m = await findTaskByTitle(client, 'wash car');
  assert.equal(m.kind, 'none');
});

test('friendlyTaskError maps known HTTP statuses to actionable text', () => {
  assert.match(friendlyTaskError(new TasksApiError(401, 'x')), /modulus auth/);
  assert.match(friendlyTaskError(new TasksApiError(403, 'x')), /modulus auth/);
  assert.match(friendlyTaskError(new TasksApiError(404, 'x')), /not found/);
  assert.match(friendlyTaskError(new TasksApiError(429, 'x')), /rate limit/);
  assert.match(friendlyTaskError(new TasksApiError(503, 'down')), /Google Tasks is having/);
  assert.match(friendlyTaskError(new TasksApiError(418, 'teapot')), /Google Tasks error \(418\)/);
});

test('friendlyTaskError stringifies non-API errors', () => {
  assert.equal(friendlyTaskError(new Error('boom')), 'boom');
  assert.equal(friendlyTaskError('plain'), 'plain');
});
