import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../storage/db.js';
import { createStandingOrderStore, type StandingOrderHandlers } from './standing-orders.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'modulus-standing-'));
  const db = open({ path: join(dir, 'g.db') });
  const store = createStandingOrderStore(db);
  return {
    db,
    store,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// A handler that records agent dispatches and never has a missing agent.
function recordingHandlers(
  extra: Partial<StandingOrderHandlers> = {},
): StandingOrderHandlers & { dispatched: number[] } {
  const dispatched: number[] = [];
  let nextTaskId = 1;
  return Object.assign(
    {
      dispatchAgent: (agentId: number) => {
        dispatched.push(agentId);
        return nextTaskId++;
      },
      ...extra,
    },
    { dispatched },
  );
}

test('a notify-only order emits a nudge and records evaluation', () => {
  const { store, cleanup } = setup();
  try {
    const order = store.create({ instruction: 'water the plants', notifyChatId: 7 });
    const at = new Date('2026-06-15T12:00:00Z');
    const { fired, nudges, tasksEnqueued } = store.evaluateDue(recordingHandlers(), at);

    assert.equal(fired.length, 1);
    assert.equal(tasksEnqueued, 0);
    assert.equal(nudges.length, 1);
    assert.equal(nudges[0]!.chatId, 7);
    assert.equal(nudges[0]!.text, 'water the plants');
    const after = store.get(order.id)!;
    assert.equal(after.lastEvaluatedAt, at.getTime());
    assert.equal(after.lastFiredAt, at.getTime());
  } finally {
    cleanup();
  }
});

test('cadence gates re-evaluation until the interval elapses', () => {
  const { store, cleanup } = setup();
  try {
    store.create({ instruction: 'stretch', notifyChatId: 1, cadenceMs: 60_000 });
    const h = recordingHandlers();
    const t0 = new Date('2026-06-15T12:00:00Z');
    assert.equal(store.evaluateDue(h, t0).nudges.length, 1); // first beat fires
    assert.equal(store.evaluateDue(h, new Date(t0.getTime() + 30_000)).nudges.length, 0); // too soon
    assert.equal(store.evaluateDue(h, new Date(t0.getTime() + 61_000)).nudges.length, 1); // due again
  } finally {
    cleanup();
  }
});

test('an agentic order enqueues a task and emits no nudge', () => {
  const { store, cleanup } = setup();
  try {
    store.create({ instruction: 'summarise unread email', agentId: 9, notifyChatId: 3 });
    const h = recordingHandlers();
    const r = store.evaluateDue(h, new Date('2026-06-15T12:00:00Z'));
    assert.equal(r.tasksEnqueued, 1);
    assert.equal(r.nudges.length, 0);
    assert.deepEqual(h.dispatched, [9]);
  } finally {
    cleanup();
  }
});

test('a watch persists tools/preapproved and passes them to dispatch', () => {
  const { store, cleanup } = setup();
  try {
    const order = store.create({
      instruction: 'check the page',
      agentId: 9,
      notifyChatId: 3,
      tools: ['modulus-browser', ' ', 'browser_read'],
      preapprovedTools: ['browser_read'],
    });
    // Sanitized on the way in (blank dropped) and round-trips off the row.
    assert.deepEqual(order.tools, ['modulus-browser', 'browser_read']);
    assert.deepEqual(order.preapprovedTools, ['browser_read']);
    assert.deepEqual(store.get(order.id)!.tools, ['modulus-browser', 'browser_read']);

    let seen: { tools?: string[] | null; preapprovedTools?: string[] | null } | undefined;
    const h: StandingOrderHandlers = {
      dispatchAgent: (_id, _instr, _chat, grant) => {
        seen = grant;
        return 1;
      },
    };
    store.evaluateDue(h, new Date('2026-06-15T12:00:00Z'));
    assert.deepEqual(seen?.tools, ['modulus-browser', 'browser_read']);
    assert.deepEqual(seen?.preapprovedTools, ['browser_read']);
  } finally {
    cleanup();
  }
});

test('editing a watch can clear its tools/preapproved', () => {
  const { store, cleanup } = setup();
  try {
    const order = store.create({
      instruction: 'check',
      agentId: 2,
      notifyChatId: 1,
      tools: ['web_search'],
      preapprovedTools: ['web_search'],
    });
    const updated = store.update(order.id, { tools: null, preapprovedTools: [] });
    assert.equal(updated!.tools, null);
    assert.equal(updated!.preapprovedTools, null);
    // An untouched field keeps its value.
    const again = store.update(order.id, { instruction: 'check again' });
    assert.equal(again!.tools, null);
  } finally {
    cleanup();
  }
});

test('a vanished agent (dispatch returns null) does not fire', () => {
  const { store, cleanup } = setup();
  try {
    const order = store.create({ instruction: 'x', agentId: 99, notifyChatId: 3 });
    const h: StandingOrderHandlers = { dispatchAgent: () => null };
    const r = store.evaluateDue(h, new Date('2026-06-15T12:00:00Z'));
    assert.equal(r.tasksEnqueued, 0);
    assert.equal(r.fired.length, 0);
    // Still recorded as evaluated, just not fired.
    assert.ok(store.get(order.id)!.lastEvaluatedAt);
    assert.equal(store.get(order.id)!.lastFiredAt, null);
  } finally {
    cleanup();
  }
});

test('notify_on_change fires only when the probed state differs', () => {
  const { store, cleanup } = setup();
  try {
    const order = store.create({
      instruction: 'btc dropped',
      notifyChatId: 5,
      notifyOnChange: true,
    });
    let state = 'high';
    const h: StandingOrderHandlers = { dispatchAgent: () => null, probe: () => state };

    // First evaluation: lastState null → 'high' is a change → fires.
    assert.equal(store.evaluateDue(h, new Date('2026-06-15T12:00:00Z')).nudges.length, 1);
    assert.equal(store.get(order.id)!.lastState, 'high');
    // Unchanged → no fire.
    assert.equal(store.evaluateDue(h, new Date('2026-06-15T12:05:00Z')).nudges.length, 0);
    // Changed → fires.
    state = 'low';
    assert.equal(store.evaluateDue(h, new Date('2026-06-15T12:10:00Z')).nudges.length, 1);
    assert.equal(store.get(order.id)!.lastState, 'low');
  } finally {
    cleanup();
  }
});

test('a cron order catches up: fires on the first beat at/after its time', () => {
  const { db, store, cleanup } = setup();
  try {
    // 09:15 daily, but a 30-min heartbeat only beats at :00 and :30 — an
    // exact-minute match would never fire. Anchor the order's clock to 09:00.
    const order = store.create({
      instruction: 'morning check',
      notifyChatId: 2,
      cron: '15 9 * * *',
      timeZone: 'UTC',
    });
    const base = new Date('2026-06-15T09:00:00Z').getTime();
    db.prepare('UPDATE standing_orders SET created_at = ?, last_evaluated_at = ? WHERE id = ?').run(
      base,
      base,
      order.id,
    );
    const h = recordingHandlers();
    assert.equal(store.evaluateDue(h, new Date('2026-06-15T09:00:00Z')).nudges.length, 0); // 09:15 not yet
    assert.equal(store.evaluateDue(h, new Date('2026-06-15T09:30:00Z')).nudges.length, 1); // fires off-minute
    assert.equal(store.evaluateDue(h, new Date('2026-06-15T10:00:00Z')).nudges.length, 0); // no second fire
    assert.equal(store.evaluateDue(h, new Date('2026-06-16T09:30:00Z')).nudges.length, 1); // again next day
  } finally {
    cleanup();
  }
});

test('notify_on_change without a probe stays silent (no per-beat spam)', () => {
  const { store, cleanup } = setup();
  try {
    store.create({ instruction: 'btc moved', notifyChatId: 5, notifyOnChange: true });
    const h = recordingHandlers(); // no probe wired
    assert.equal(store.evaluateDue(h, new Date('2026-06-15T12:00:00Z')).nudges.length, 0);
    assert.equal(store.evaluateDue(h, new Date('2026-06-15T12:30:00Z')).nudges.length, 0);
  } finally {
    cleanup();
  }
});

test('list and removeForChat are chat-scoped', () => {
  const { store, cleanup } = setup();
  try {
    const a = store.create({ instruction: 'a', notifyChatId: 100 });
    store.create({ instruction: 'b', notifyChatId: 200 });
    assert.equal(store.list({ chatId: 100 }).length, 1);
    assert.equal(store.removeForChat(200, a.id), false); // wrong chat
    assert.equal(store.removeForChat(100, a.id), true);
    assert.equal(store.get(a.id), undefined);
  } finally {
    cleanup();
  }
});

test('create rejects an order with neither agent nor chat, and a bad cron', () => {
  const { store, cleanup } = setup();
  try {
    assert.throws(() => store.create({ instruction: 'x' }));
    assert.throws(() => store.create({ instruction: 'x', notifyChatId: 1, cron: '99 99 * * *' }));
  } finally {
    cleanup();
  }
});

test('update edits fields, keeps untouched ones, and rejects a bad cron', () => {
  const { store, cleanup } = setup();
  try {
    const o = store.create({ instruction: 'watch', agentId: 5, cron: '0 8 * * *' });

    // Touch only the instruction; agent + cron are preserved.
    const u1 = store.update(o.id, { instruction: 'watch harder' });
    assert.equal(u1?.instruction, 'watch harder');
    assert.equal(u1?.agentId, 5);
    assert.equal(u1?.cron, '0 8 * * *');

    // Clear the cron and switch to notify-only.
    const u2 = store.update(o.id, { cron: null, agentId: null, notifyChatId: 42 });
    assert.equal(u2?.cron, null);
    assert.equal(u2?.agentId, null);
    assert.equal(u2?.notifyChatId, 42);

    // Can't end up with neither an agent nor a chat; bad cron throws.
    assert.throws(() => store.update(o.id, { notifyChatId: null }));
    assert.throws(() => store.update(o.id, { cron: '99 99 * * *' }));
    assert.equal(store.update(999, { instruction: 'x' }), undefined);
  } finally {
    cleanup();
  }
});
