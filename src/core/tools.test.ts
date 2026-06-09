import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createToolRegistry, validateArgs, ToolTimeoutError } from './tools.js';
import { createLogger } from '../util/log.js';

const log = createLogger({ level: 'error', out: () => {}, err: () => {} });

test('register + execute happy path', async () => {
  const r = createToolRegistry({ log });
  r.register({
    name: 'echo',
    description: 'echo back',
    parameters: { type: 'object', properties: { text: { type: 'string' } } },
    tier: 'auto',
    invoke: async (args) => `you said: ${(args as { text: string }).text}`,
  });
  const res = await r.execute({ id: '1', name: 'echo', arguments: { text: 'hi' } }, { log });
  assert.equal(res.ok, true);
  assert.equal(res.output, 'you said: hi');
});

test('unknown tool returns ok=false', async () => {
  const r = createToolRegistry({ log });
  const res = await r.execute({ id: '1', name: 'missing', arguments: {} }, { log });
  assert.equal(res.ok, false);
  assert.match(res.output, /unknown tool/);
});

test('confirm-tier tool requires the confirm hook to approve', async () => {
  let asked = 0;
  const r = createToolRegistry({
    log,
    confirm: async () => {
      asked++;
      return false;
    },
  });
  r.register({
    name: 'wipe',
    description: 'destructive',
    parameters: {},
    tier: 'confirm',
    invoke: async () => 'done',
  });
  const res = await r.execute({ id: '1', name: 'wipe', arguments: {} }, { log });
  assert.equal(res.ok, false);
  assert.match(res.output, /not confirmed/);
  assert.equal(asked, 1);
});

test('owner-tier tool blocked when isOwner returns false', async () => {
  const r = createToolRegistry({ log, isOwner: () => false });
  r.register({
    name: 'admin',
    description: 'admin',
    parameters: {},
    tier: 'owner',
    invoke: async () => 'ok',
  });
  const res = await r.execute({ id: '1', name: 'admin', arguments: {} }, { log });
  assert.equal(res.ok, false);
  assert.match(res.output, /owner-only/);
});

test('schemas() shape matches Ollama tool format', () => {
  const r = createToolRegistry({ log });
  r.register({
    name: 'add',
    description: 'add two numbers',
    parameters: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
    tier: 'auto',
    invoke: async () => '0',
  });
  const s = r.schemas()[0]!;
  assert.equal(s.type, 'function');
  assert.equal(s.function.name, 'add');
  assert.deepEqual(s.function.parameters, {
    type: 'object',
    properties: { a: { type: 'number' }, b: { type: 'number' } },
    required: ['a', 'b'],
  });
});

test('duplicate registration throws', () => {
  const r = createToolRegistry({ log });
  r.register({
    name: 'x',
    description: '',
    parameters: {},
    tier: 'auto',
    invoke: async () => '',
  });
  assert.throws(() =>
    r.register({
      name: 'x',
      description: '',
      parameters: {},
      tier: 'auto',
      invoke: async () => '',
    }),
  );
});

test('schema validation rejects wrong types and missing required keys', async () => {
  const r = createToolRegistry({ log });
  r.register({
    name: 'add_event',
    description: 'add a calendar event',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string' },
        priority: { type: 'integer', enum: [1, 2, 3] },
      },
      required: ['date'],
    },
    tier: 'auto',
    invoke: async () => 'ok',
  });
  // Missing required key.
  let res = await r.execute({ id: '1', name: 'add_event', arguments: { priority: 1 } }, { log });
  assert.equal(res.ok, false);
  assert.match(res.output, /missing required property 'date'/);

  // Wrong type — model emits a number where a string was expected.
  res = await r.execute({ id: '2', name: 'add_event', arguments: { date: 12345 } }, { log });
  assert.equal(res.ok, false);
  assert.match(res.output, /expected string/);

  // Enum violation.
  res = await r.execute(
    { id: '3', name: 'add_event', arguments: { date: '2026-05-04', priority: 9 } },
    { log },
  );
  assert.equal(res.ok, false);
  assert.match(res.output, /not in enum/);

  // Valid arguments pass validation and reach the handler.
  res = await r.execute(
    { id: '4', name: 'add_event', arguments: { date: '2026-05-04', priority: 1 } },
    { log },
  );
  assert.equal(res.ok, true);
  assert.equal(res.output, 'ok');
});

test('skipValidation lets a handler see whatever the model emitted', async () => {
  const r = createToolRegistry({ log });
  r.register({
    name: 'raw',
    description: 'raw',
    parameters: {
      type: 'object',
      properties: { n: { type: 'integer' } },
      required: ['n'],
    },
    tier: 'auto',
    skipValidation: true,
    invoke: async (args) => JSON.stringify(args),
  });
  const res = await r.execute({ id: '1', name: 'raw', arguments: { n: 'not a number' } }, { log });
  assert.equal(res.ok, true);
  assert.match(res.output, /not a number/);
});

test('per-tool timeout aborts a hung handler', async () => {
  const r = createToolRegistry({ log });
  r.register({
    name: 'slow',
    description: 'never returns',
    parameters: {},
    tier: 'auto',
    timeoutMs: 25,
    invoke: (_args, ctx) =>
      new Promise<string>((_, reject) => {
        ctx.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
  });
  const res = await r.execute({ id: '1', name: 'slow', arguments: {} }, { log });
  assert.equal(res.ok, false);
  assert.match(res.output, /timed out/);
});

test('ToolTimeoutError carries the configured budget', () => {
  const e = new ToolTimeoutError(15000);
  assert.equal(e.timeoutMs, 15000);
  assert.match(e.message, /15000ms/);
});

test('onAfterExecute listener fires only on success and only for the matching tool', async () => {
  const r = createToolRegistry({ log });
  const fired: string[] = [];
  r.register({
    name: 'add_event',
    description: 'add',
    parameters: {},
    tier: 'auto',
    invoke: async () => 'added',
  });
  r.register({
    name: 'list_events',
    description: 'list',
    parameters: {},
    tier: 'auto',
    invoke: async () => 'listed',
  });
  r.register({
    name: 'broken',
    description: 'fails',
    parameters: {},
    tier: 'auto',
    invoke: async () => {
      throw new Error('nope');
    },
  });
  r.onAfterExecute('add_event', (call) => {
    fired.push(call.name);
  });
  await r.execute({ id: '1', name: 'add_event', arguments: {} }, { log });
  await r.execute({ id: '2', name: 'list_events', arguments: {} }, { log });
  await r.execute({ id: '3', name: 'broken', arguments: {} }, { log });
  // add_event success should fire; list_events shouldn't (different name);
  // broken shouldn't (failed).
  assert.deepEqual(fired, ['add_event']);
});

test('onAfterExecute disposer drops the listener', async () => {
  const r = createToolRegistry({ log });
  let fires = 0;
  r.register({
    name: 't',
    description: '',
    parameters: {},
    tier: 'auto',
    invoke: async () => 'ok',
  });
  const off = r.onAfterExecute('t', () => {
    fires += 1;
  });
  await r.execute({ id: '1', name: 't', arguments: {} }, { log });
  off();
  await r.execute({ id: '2', name: 't', arguments: {} }, { log });
  assert.equal(fires, 1);
});

test('validateArgs returns clean diagnostics for each failure mode', () => {
  const schema = {
    type: 'object',
    properties: {
      name: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
      mode: { type: 'string', enum: ['a', 'b'] },
    },
    required: ['name'],
  };
  assert.deepEqual(validateArgs({ name: 'x' }, schema), []);
  assert.match(validateArgs({}, schema)[0]!, /missing required property 'name'/);
  assert.match(validateArgs({ name: 1 }, schema)[0]!, /expected string/);
  assert.match(
    validateArgs({ name: 'x', tags: ['ok', 1] }, schema)[0]!,
    /tags\[1\]: expected string/,
  );
  assert.match(validateArgs({ name: 'x', mode: 'c' }, schema)[0]!, /not in enum/);
});

test('schemasFor narrows matching extension tools by per-tool intent', () => {
  const tools = createToolRegistry({ log });
  tools.register({
    name: 'core_ping',
    description: 'core',
    tier: 'auto',
    parameters: { type: 'object', properties: {} },
    invoke: async () => 'ok',
  });
  tools.register({
    name: 'tasks_add',
    description: 'add task',
    tier: 'auto',
    extension: 'everyday',
    intentPattern: '\\b(task|todo|need to)\\b',
    parameters: { type: 'object', properties: {} },
    invoke: async () => 'ok',
  });
  tools.register({
    name: 'weather_get',
    description: 'weather',
    tier: 'auto',
    extension: 'everyday',
    intentPattern: '\\b(weather|forecast)\\b',
    parameters: { type: 'object', properties: {} },
    invoke: async () => 'ok',
  });
  tools.register({
    name: 'calendar_add',
    description: 'calendar',
    tier: 'auto',
    extension: 'everyday',
    intentPattern: '\\b(calendar|event)\\b',
    parameters: { type: 'object', properties: {} },
    invoke: async () => 'ok',
  });

  const schemas = tools.schemasFor(new Set(['everyday']), 'add buy milk to my todo list');
  assert.deepEqual(
    schemas.map((s) => s.function.name),
    ['core_ping', 'tasks_add'],
  );
});

test('schemasFor falls back to all extension tools if per-tool intent misses', () => {
  const tools = createToolRegistry({ log });
  tools.register({
    name: 'taskish',
    description: 'task',
    tier: 'auto',
    extension: 'everyday',
    intentPattern: '\\btask\\b',
    parameters: { type: 'object', properties: {} },
    invoke: async () => 'ok',
  });
  tools.register({
    name: 'weatherish',
    description: 'weather',
    tier: 'auto',
    extension: 'everyday',
    intentPattern: '\\bweather\\b',
    parameters: { type: 'object', properties: {} },
    invoke: async () => 'ok',
  });

  const schemas = tools.schemasFor(new Set(['everyday']), 'what should I focus on?');
  assert.deepEqual(
    schemas.map((s) => s.function.name),
    ['taskish', 'weatherish'],
  );
});
