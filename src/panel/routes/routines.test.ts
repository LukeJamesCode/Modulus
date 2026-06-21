import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { open, type DB } from '../../storage/db.js';
import { createLogger } from '../../util/log.js';
import { createAgentRegistry, ensureBuiltinModulusAgent } from '../../core/agents.js';
import { createStandingOrderStore } from '../../core/standing-orders.js';
import type { PanelDeps } from '../types.js';
import { createRoutinesRoutes } from './routines.js';

const log = createLogger({ level: 'error', out: () => {}, err: () => {} });

interface Harness {
  reg: ReturnType<typeof createAgentRegistry>;
  call: (
    method: string,
    path: string,
    body?: unknown,
  ) => Promise<{ handled: boolean; status: number; json: Record<string, unknown> }>;
  cleanup: () => void;
}

function harness(opts?: { allowedIds?: number[] }): Harness {
  const home = mkdtempSync(join(tmpdir(), 'modulus-routines-'));
  const db: DB = open({ path: join(home, 'modulus.db'), log });
  const reg = createAgentRegistry(db);
  const deps = {
    db,
    log,
    home,
    config: { telegram: { allowedIds: opts?.allowedIds ?? [] } },
    agentRegistry: reg,
    standingOrders: createStandingOrderStore(db, log),
    llm: {},
  } as unknown as PanelDeps;
  const route = createRoutinesRoutes(deps);

  async function call(method: string, path: string, body?: unknown) {
    const req = Readable.from([
      body === undefined ? '' : JSON.stringify(body),
    ]) as unknown as IncomingMessage;
    let status = 0;
    let payload = '';
    const res = {
      writeHead: (s: number) => {
        status = s;
      },
      end: (chunk?: string) => {
        if (chunk) payload = chunk;
      },
      write: () => true,
    } as unknown as ServerResponse;
    const handled = await route({ req, res, path, method } as Parameters<typeof route>[0]);
    return { handled, status, json: payload ? (JSON.parse(payload) as Record<string, unknown>) : {} };
  }

  return {
    reg,
    call,
    cleanup: () => {
      db.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test('routines: create a repeating schedule and list it as one Routine', async () => {
  const h = harness();
  try {
    const a = h.reg.create({ name: 'assistant', systemPrompt: 's', toolAllowlist: [] });
    const created = await h.call('POST', '/api/routines', {
      kind: 'schedule',
      agentIds: [a.id],
      prompt: 'morning briefing',
      cron: '0 8 * * 1-5',
    });
    assert.equal(created.status, 200);
    const routine = created.json['routine'] as Record<string, unknown>;
    assert.equal(routine['kind'], 'schedule');
    assert.equal(routine['trigger'], 'recurring');
    assert.deepEqual(routine['agentNames'], ['assistant']);
    assert.ok(String(routine['when']).length > 0);

    const list = await h.call('GET', '/api/routines');
    assert.equal((list.json['routines'] as unknown[]).length, 1);
    assert.equal(
      (list.json['telegram'] as { available: boolean }).available,
      false,
      'no allowlist ⇒ no Telegram target',
    );
  } finally {
    h.cleanup();
  }
});

test('routines: notify resolves to the owner chat only when Telegram is set up', async () => {
  const h = harness({ allowedIds: [777] });
  try {
    const a = h.reg.create({ name: 'a', systemPrompt: 's', toolAllowlist: [] });
    const r = await h.call('POST', '/api/routines', {
      kind: 'schedule',
      agentIds: [a.id],
      prompt: 'p',
      cron: '0 9 * * *',
      notify: true,
    });
    assert.equal((r.json['routine'] as Record<string, unknown>)['notify'], true);
    const list = await h.call('GET', '/api/routines');
    assert.equal((list.json['telegram'] as { available: boolean }).available, true);
  } finally {
    h.cleanup();
  }
});

test('routines: pause, edit, and delete a schedule', async () => {
  const h = harness();
  try {
    const a = h.reg.create({ name: 'a', systemPrompt: 's', toolAllowlist: [] });
    const created = await h.call('POST', '/api/routines', {
      kind: 'schedule',
      agentIds: [a.id],
      prompt: 'old',
      cron: '0 8 * * *',
    });
    const id = (created.json['routine'] as { id: number }).id;

    const paused = await h.call('POST', `/api/routines/schedule/${id}/active`, { active: false });
    assert.equal(paused.status, 200);
    let list = await h.call('GET', '/api/routines');
    const first = (list.json['routines'] as { active: boolean }[])[0];
    assert.equal(first?.active, false);

    const edited = await h.call('PUT', `/api/routines/schedule/${id}`, {
      kind: 'schedule',
      agentIds: [a.id],
      prompt: 'new',
      cron: '30 7 * * *',
    });
    assert.equal((edited.json['routine'] as { prompt: string }).prompt, 'new');

    const del = await h.call('DELETE', `/api/routines/schedule/${id}`);
    assert.equal(del.status, 200);
    list = await h.call('GET', '/api/routines');
    assert.equal((list.json['routines'] as unknown[]).length, 0);
  } finally {
    h.cleanup();
  }
});

test('routines: a "when something changes" routine becomes a watch', async () => {
  const h = harness();
  try {
    const a = h.reg.create({ name: 'watcher', systemPrompt: 's', toolAllowlist: [] });
    const r = await h.call('POST', '/api/routines', {
      kind: 'watch',
      agentId: a.id,
      prompt: 'check the calendar and flag conflicts',
    });
    assert.equal(r.status, 200);
    assert.equal((r.json['routine'] as { kind: string }).kind, 'watch');
    const list = await h.call('GET', '/api/routines');
    const routines = list.json['routines'] as { kind: string }[];
    assert.ok(routines.some((x) => x.kind === 'watch'));
  } finally {
    h.cleanup();
  }
});

test('routines: parse previews a plain-English time; validation rejects bad input', async () => {
  const h = harness();
  try {
    const parsed = await h.call('POST', '/api/routines/parse', { text: 'every weekday at 8am' });
    assert.equal(parsed.status, 200);
    assert.ok(parsed.json['cron'], 'a repeating phrase yields a cron');

    const noAgent = await h.call('POST', '/api/routines', {
      kind: 'schedule',
      agentIds: [],
      prompt: 'x',
      cron: '0 8 * * *',
    });
    assert.equal(noAgent.status, 400);

    const a = h.reg.create({ name: 'a', systemPrompt: 's', toolAllowlist: [] });
    const past = await h.call('POST', '/api/routines', {
      kind: 'schedule',
      agentIds: [a.id],
      prompt: 'x',
      nextRunAt: Date.now() - 1000,
    });
    assert.equal(past.status, 400);
  } finally {
    h.cleanup();
  }
});

test('routines: a multi-step routine is stored with its steps', async () => {
  const h = harness();
  try {
    const a = h.reg.create({ name: 'agenda', systemPrompt: 's', toolAllowlist: [] });
    const b = h.reg.create({ name: 'news', systemPrompt: 's', toolAllowlist: [] });
    const created = await h.call('POST', '/api/routines', {
      kind: 'schedule',
      cron: '30 7 * * 1-5',
      steps: [
        { agentId: a.id, instruction: "today's agenda" },
        { agentId: b.id, instruction: 'summarize the news', condition: 'meeting' },
      ],
    });
    assert.equal(created.status, 200);
    const routine = created.json['routine'] as Record<string, unknown>;
    assert.equal(routine['stepCount'], 2);
    assert.deepEqual(routine['agentNames'], ['agenda', 'news']);
    assert.equal((routine['steps'] as unknown[]).length, 2);
  } finally {
    h.cleanup();
  }
});

test('routines: the built-in Modulus agent is hidden from the fleet but offered + named', async () => {
  const h = harness();
  try {
    const modulus = ensureBuiltinModulusAgent(h.reg);
    // Hidden from the Fleet list…
    assert.equal(
      h.reg.list().some((a) => a.id === modulus.id),
      false,
      'built-in is excluded from list()',
    );
    // …but resolvable by id (so the queue/runtime can run it).
    assert.equal(h.reg.get(modulus.id)?.name, 'Modulus');

    const created = await h.call('POST', '/api/routines', {
      kind: 'schedule',
      cron: '0 8 * * *',
      steps: [{ agentId: modulus.id, instruction: 'summarize my day' }],
    });
    assert.equal(created.status, 200);
    assert.deepEqual((created.json['routine'] as Record<string, unknown>)['agentNames'], ['Modulus']);

    const list = await h.call('GET', '/api/routines');
    assert.equal((list.json['modulus'] as { name: string }).name, 'Modulus');
    const first = (list.json['routines'] as { agentNames: string[]; running: boolean }[])[0];
    assert.deepEqual(first?.agentNames, ['Modulus']);
    assert.equal(first?.running, false, 'not running until a task is in flight');
  } finally {
    h.cleanup();
  }
});

test('routines: a single-step create still round-trips as one editable step', async () => {
  const h = harness();
  try {
    const a = h.reg.create({ name: 'a', systemPrompt: 's', toolAllowlist: [] });
    const created = await h.call('POST', '/api/routines', {
      kind: 'schedule',
      cron: '0 8 * * *',
      steps: [{ agentId: a.id, instruction: 'do the thing' }],
    });
    assert.equal(created.status, 200);
    const routine = created.json['routine'] as Record<string, unknown>;
    // Collapsed to legacy storage, but the view still exposes a 1-step list.
    assert.equal(routine['stepCount'], 1);
    assert.equal((routine['steps'] as { instruction: string }[])[0]?.instruction, 'do the thing');
  } finally {
    h.cleanup();
  }
});
