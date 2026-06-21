import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../storage/db.js';
import { createAgentRegistry } from './agents.js';
import { createAgentScheduleStore } from './agent-schedules.js';

function tmp() {
  return mkdtempSync(join(tmpdir(), 'modulus-agent-schedules-'));
}

test('agent schedules: a one-shot schedule can enqueue the same task for multiple agents', () => {
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    const reg = createAgentRegistry(db);
    const writer = reg.create({ name: 'writer', systemPrompt: 'write', toolAllowlist: [] });
    const critic = reg.create({ name: 'critic', systemPrompt: 'critic', toolAllowlist: [] });
    const store = createAgentScheduleStore(db, reg);
    const now = Date.now();

    const schedule = store.create({
      agentIds: [writer.id, critic.id],
      prompt: 'Draft and review the note',
      nextRunAt: now - 1,
      recurrence: 'once',
    });
    const { fired } = store.sweepDue(
      (agentId, prompt) => reg.enqueue({ agentId, prompt }),
      new Date(now),
    );

    assert.equal(fired.length, 1);
    const tasks = reg.listTasks({ status: 'queued' });
    assert.equal(tasks.length, 2);
    assert.deepEqual(
      tasks.map((t) => t.agentId).sort((a, b) => a - b),
      [writer.id, critic.id],
    );
    assert.equal(store.get(schedule.id)?.active, false);
    assert.equal(store.get(schedule.id)?.lastTaskIds.length, 2);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('agent schedules: monthly recurrence clamps the day instead of drifting', () => {
  const dir = tmp();
  const db = open({ path: join(dir, 'g.db') });
  try {
    const reg = createAgentRegistry(db);
    const planner = reg.create({ name: 'planner', systemPrompt: 'plan', toolAllowlist: [] });
    const store = createAgentScheduleStore(db, reg);
    // Built from local components so the assertion is timezone-agnostic.
    const first = new Date(2026, 0, 31, 9, 0, 0).getTime(); // Jan 31 2026 09:00 local
    const sweepAt = new Date(2026, 0, 31, 12, 0, 0); // same day, after the run time

    const schedule = store.create({
      agentIds: [planner.id],
      prompt: 'Monthly review',
      nextRunAt: first,
      recurrence: 'monthly',
    });
    store.sweepDue((agentId, prompt) => reg.enqueue({ agentId, prompt }), sweepAt);

    const next = new Date(store.get(schedule.id)!.nextRunAt);
    assert.equal(next.getMonth(), 1); // February, not March (no overflow drift)
    assert.equal(next.getDate(), 28); // clamped to Feb's last day (2026 is not a leap year)
    assert.equal(next.getHours(), 9); // time of day preserved
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('agent schedules: yearly recurrence clamps a leap day to Feb 28', () => {
  const dir = tmp();
  const db = open({ path: join(dir, 'g.db') });
  try {
    const reg = createAgentRegistry(db);
    const planner = reg.create({ name: 'planner', systemPrompt: 'plan', toolAllowlist: [] });
    const store = createAgentScheduleStore(db, reg);
    const first = new Date(2028, 1, 29, 9, 0, 0).getTime(); // Feb 29 2028 (leap) 09:00 local
    const sweepAt = new Date(2028, 1, 29, 12, 0, 0); // same day, after the run time

    const schedule = store.create({
      agentIds: [planner.id],
      prompt: 'Yearly review',
      nextRunAt: first,
      recurrence: 'yearly',
    });
    store.sweepDue((agentId, prompt) => reg.enqueue({ agentId, prompt }), sweepAt);

    const next = new Date(store.get(schedule.id)!.nextRunAt);
    assert.equal(next.getFullYear(), 2029);
    assert.equal(next.getMonth(), 1); // February
    assert.equal(next.getDate(), 28); // 2029 is not a leap year
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('agent schedules: recurring schedules advance after firing', () => {
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    const reg = createAgentRegistry(db);
    const planner = reg.create({ name: 'planner', systemPrompt: 'plan', toolAllowlist: [] });
    const store = createAgentScheduleStore(db, reg);
    const first = Date.parse('2026-06-01T09:00:00Z');
    const sweepAt = Date.parse('2026-06-04T10:00:00Z');

    const schedule = store.create({
      agentIds: [planner.id],
      prompt: 'Morning planning',
      nextRunAt: first,
      recurrence: 'daily',
    });
    store.sweepDue((agentId, prompt) => reg.enqueue({ agentId, prompt }), new Date(sweepAt));

    const updated = store.get(schedule.id)!;
    assert.equal(updated.active, true);
    assert.equal(updated.nextRunAt, Date.parse('2026-06-05T09:00:00Z'));
    assert.equal(reg.listTasks({ status: 'queued' }).length, 1);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('agent schedules: a cron row advances via nextFireAfter and stays active', () => {
  const dir = tmp();
  const db = open({ path: join(dir, 'g.db') });
  try {
    const reg = createAgentRegistry(db);
    const planner = reg.create({ name: 'planner', systemPrompt: 'plan', toolAllowlist: [] });
    const store = createAgentScheduleStore(db, reg);
    // Every weekday at 08:00 UTC, first fire pinned to Thursday 2026-06-04 so
    // the sweep below is deterministic regardless of the wall clock.
    const schedule = store.create({
      agentIds: [planner.id],
      prompt: 'Standup',
      cron: '0 8 * * 1-5',
      timeZone: 'UTC',
      nextRunAt: Date.parse('2026-06-04T08:00:00Z'),
    });
    // Thursday 2026-06-04 09:00 UTC — past today's 08:00, so the next fire is
    // Friday 08:00.
    store.sweepDue(
      (agentId, prompt) => reg.enqueue({ agentId, prompt }),
      new Date('2026-06-04T09:00:00Z'),
    );

    const updated = store.get(schedule.id)!;
    assert.equal(updated.active, true);
    assert.equal(updated.nextRunAt, Date.parse('2026-06-05T08:00:00Z')); // Fri 08:00
    assert.equal(reg.listTasks({ status: 'queued' }).length, 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('agent schedules: a notify-only reminder emits a nudge instead of a task', () => {
  const dir = tmp();
  const db = open({ path: join(dir, 'g.db') });
  try {
    const reg = createAgentRegistry(db);
    const store = createAgentScheduleStore(db, reg);
    const now = Date.now();

    const schedule = store.create({
      agentIds: [],
      prompt: 'Take your pills',
      nextRunAt: now - 1,
      recurrence: 'once',
      notifyChatId: 4242,
    });
    const { fired, nudges } = store.sweepDue(
      (agentId, prompt) => reg.enqueue({ agentId, prompt }),
      new Date(now),
    );

    assert.equal(fired.length, 1);
    assert.equal(
      reg.listTasks({ status: 'queued' }).length,
      0,
      'no agent task for a notify-only row',
    );
    assert.equal(nudges.length, 1);
    assert.equal(nudges[0]!.chatId, 4242);
    assert.equal(nudges[0]!.text, 'Take your pills');
    assert.equal(store.get(schedule.id)?.active, false); // one-shot deactivates
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('agent schedules: removeForChat only deletes a reminder owned by that chat', () => {
  const dir = tmp();
  const db = open({ path: join(dir, 'g.db') });
  try {
    const reg = createAgentRegistry(db);
    const store = createAgentScheduleStore(db, reg);
    const s = store.create({
      agentIds: [],
      prompt: 'ping',
      nextRunAt: Date.now() + 60_000,
      notifyChatId: 100,
    });
    assert.equal(store.removeForChat(999, s.id), false, 'wrong chat cannot delete');
    assert.ok(store.get(s.id), 'still present');
    assert.equal(store.removeForChat(100, s.id), true);
    assert.equal(store.get(s.id), undefined);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('agent schedules: setActive pauses and resumes a row', () => {
  const dir = tmp();
  const db = open({ path: join(dir, 'g.db') });
  try {
    const reg = createAgentRegistry(db);
    const a = reg.create({ name: 'a', systemPrompt: 's', toolAllowlist: [] });
    const store = createAgentScheduleStore(db, reg);
    const s = store.create({ agentIds: [a.id], prompt: 'p', cron: '0 8 * * *' });
    assert.equal(store.get(s.id)?.active, true);
    assert.equal(store.setActive(s.id, false), true);
    assert.equal(store.get(s.id)?.active, false);
    assert.equal(store.setActive(s.id, true), true);
    assert.equal(store.get(s.id)?.active, true);
    assert.equal(store.setActive(999, false), false, 'missing id reports no change');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('agent schedules: update edits fields and re-validates timing', () => {
  const dir = tmp();
  const db = open({ path: join(dir, 'g.db') });
  try {
    const reg = createAgentRegistry(db);
    const a = reg.create({ name: 'a', systemPrompt: 's', toolAllowlist: [] });
    const b = reg.create({ name: 'b', systemPrompt: 's', toolAllowlist: [] });
    const store = createAgentScheduleStore(db, reg);
    const s = store.create({ agentIds: [a.id], prompt: 'old', cron: '0 8 * * *' });

    // Edit only the prompt + agents; timing is reconstructed from the existing row.
    const u1 = store.update(s.id, { prompt: 'new', agentIds: [a.id, b.id] });
    assert.equal(u1?.prompt, 'new');
    assert.deepEqual(u1?.agentIds.sort((x, y) => x - y), [a.id, b.id]);
    assert.equal(u1?.cron, '0 8 * * *', 'cron preserved when not touched');

    // Switch from cron to a one-time run.
    const future = Date.now() + 3_600_000;
    const u2 = store.update(s.id, { cron: null, nextRunAt: future, recurrence: 'once' });
    assert.equal(u2?.cron, null);
    assert.equal(u2?.recurrence, 'once');
    assert.equal(u2?.nextRunAt, future);

    // A bad cron is rejected, leaving the row unchanged.
    assert.throws(() => store.update(s.id, { cron: '99 99 * * *' }));
    assert.equal(store.update(999, { prompt: 'x' }), undefined, 'missing id returns undefined');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('agent schedules: a multi-step routine stores steps; the sweep leaves it for the runner', () => {
  const dir = tmp();
  const db = open({ path: join(dir, 'g.db') });
  try {
    const reg = createAgentRegistry(db);
    const a = reg.create({ name: 'a', systemPrompt: 's', toolAllowlist: [] });
    const b = reg.create({ name: 'b', systemPrompt: 's', toolAllowlist: [] });
    const store = createAgentScheduleStore(db, reg);
    const now = Date.now();

    const s = store.create({
      agentIds: [],
      steps: [
        { agentId: a.id, instruction: 'step one' },
        { agentId: b.id, instruction: 'step two', condition: 'ok' },
      ],
      nextRunAt: now - 1,
      recurrence: 'once',
    });
    assert.equal(s.steps?.length, 2);
    assert.deepEqual(s.agentIds, []);
    assert.equal(s.prompt, 'step one', 'prompt defaults to the first step');

    // The sweep must NOT dispatch a stepped row — the runner owns it. The
    // dispatch callback should never be called; the row still fires + advances.
    let dispatched = 0;
    const { fired } = store.sweepDue(() => {
      dispatched += 1;
      return reg.enqueue({ agentId: a.id, prompt: 'x' });
    }, new Date(now));
    assert.equal(dispatched, 0, 'stepped rows are not dispatched inline');
    assert.equal(fired.length, 1);
    assert.equal(fired[0]?.steps?.length, 2);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('agent schedules: a single unconditional step collapses to the legacy path', () => {
  const dir = tmp();
  const db = open({ path: join(dir, 'g.db') });
  try {
    const reg = createAgentRegistry(db);
    const a = reg.create({ name: 'a', systemPrompt: 's', toolAllowlist: [] });
    const store = createAgentScheduleStore(db, reg);
    const s = store.create({
      agentIds: [],
      steps: [{ agentId: a.id, instruction: 'just do this' }],
      cron: '0 8 * * *',
    });
    assert.equal(s.steps, null, 'a single step is stored as a legacy schedule');
    assert.deepEqual(s.agentIds, [a.id]);
    assert.equal(s.prompt, 'just do this');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('agent schedules: recordRun fills in the last run outcome', () => {
  const dir = tmp();
  const db = open({ path: join(dir, 'g.db') });
  try {
    const reg = createAgentRegistry(db);
    const a = reg.create({ name: 'a', systemPrompt: 's', toolAllowlist: [] });
    const store = createAgentScheduleStore(db, reg);
    const s = store.create({ agentIds: [a.id], prompt: 'p', cron: '0 8 * * *' });
    assert.equal(store.get(s.id)?.lastStatus, null);
    store.recordRun(s.id, { status: 'ok', result: 'all good' });
    assert.equal(store.get(s.id)?.lastStatus, 'ok');
    assert.equal(store.get(s.id)?.lastResult, 'all good');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
