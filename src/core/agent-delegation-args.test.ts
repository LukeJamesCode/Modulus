import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseSpawnAgentsArgs } from './agent-delegation-args.js';

// Contract for the spawn_agents argument validator. The tool calls this before
// it touches the registry, so the WHY here is security + robustness: a tiny
// supervisor model emits these args, and the tool fans them out into real agent
// runs with inherited tool grants. A malformed batch must be rejected with one
// clear message, never silently partially-run. Order and duplicates are
// preserved on purpose — two subtasks to the same worker is a legitimate
// fan-out (e.g. summarise two different documents).

const MAX = 8;

test('accepts a well-formed batch and preserves order', () => {
  const r = parseSpawnAgentsArgs(
    {
      tasks: [
        { agent: 'researcher', task: 'gather calendar' },
        { agent: 'researcher', task: 'gather weather' },
      ],
    },
    MAX,
  );
  assert.equal(r.ok, true);
  assert.ok(r.ok && r.tasks.length === 2);
  assert.ok(r.ok && r.tasks[0]!.task === 'gather calendar');
  assert.ok(r.ok && r.tasks[1]!.task === 'gather weather');
});

test('trims surrounding whitespace on agent and task', () => {
  const r = parseSpawnAgentsArgs({ tasks: [{ agent: '  writer ', task: ' draft it ' }] }, MAX);
  assert.ok(r.ok && r.tasks[0]!.agent === 'writer');
  assert.ok(r.ok && r.tasks[0]!.task === 'draft it');
});

test('rejects a missing or non-array tasks field', () => {
  assert.equal(parseSpawnAgentsArgs({}, MAX).ok, false);
  assert.equal(parseSpawnAgentsArgs({ tasks: 'nope' }, MAX).ok, false);
  assert.equal(parseSpawnAgentsArgs({ tasks: {} }, MAX).ok, false);
});

test('rejects an empty batch', () => {
  assert.equal(parseSpawnAgentsArgs({ tasks: [] }, MAX).ok, false);
});

test('rejects an element that is not an object', () => {
  assert.equal(parseSpawnAgentsArgs({ tasks: ['just a string'] }, MAX).ok, false);
  assert.equal(parseSpawnAgentsArgs({ tasks: [null] }, MAX).ok, false);
});

test('rejects a missing, empty, or whitespace-only agent', () => {
  assert.equal(parseSpawnAgentsArgs({ tasks: [{ task: 't' }] }, MAX).ok, false);
  assert.equal(parseSpawnAgentsArgs({ tasks: [{ agent: '', task: 't' }] }, MAX).ok, false);
  assert.equal(parseSpawnAgentsArgs({ tasks: [{ agent: '   ', task: 't' }] }, MAX).ok, false);
});

test('rejects a missing, empty, or whitespace-only task', () => {
  assert.equal(parseSpawnAgentsArgs({ tasks: [{ agent: 'a' }] }, MAX).ok, false);
  assert.equal(parseSpawnAgentsArgs({ tasks: [{ agent: 'a', task: '' }] }, MAX).ok, false);
  assert.equal(parseSpawnAgentsArgs({ tasks: [{ agent: 'a', task: '  ' }] }, MAX).ok, false);
});

test('rejects non-string agent or task values', () => {
  assert.equal(parseSpawnAgentsArgs({ tasks: [{ agent: 1, task: 't' }] }, MAX).ok, false);
  assert.equal(parseSpawnAgentsArgs({ tasks: [{ agent: 'a', task: 5 }] }, MAX).ok, false);
});

test('rejects a batch larger than maxTasks', () => {
  const tasks = Array.from({ length: MAX + 1 }, (_, i) => ({ agent: 'a', task: `t${i}` }));
  assert.equal(parseSpawnAgentsArgs({ tasks }, MAX).ok, false);
});

test('accepts a batch exactly at maxTasks', () => {
  const tasks = Array.from({ length: MAX }, (_, i) => ({ agent: 'a', task: `t${i}` }));
  assert.equal(parseSpawnAgentsArgs({ tasks }, MAX).ok, true);
});

test('an error result carries a non-empty human-readable message', () => {
  const r = parseSpawnAgentsArgs({ tasks: [] }, MAX);
  assert.ok(!r.ok && typeof r.error === 'string' && r.error.length > 0);
});
