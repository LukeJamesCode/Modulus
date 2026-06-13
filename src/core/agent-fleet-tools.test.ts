// Fleet-control tools: the main chat's command surface over the whole agent
// fleet (dispatch by name, status, pause/resume/cancel). All three are
// chat-only and must refuse from inside an agent chat.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../storage/db.js';
import { createLogger } from '../util/log.js';
import { createToolRegistry, type ToolContext } from './tools.js';
import { createAgentRegistry, AGENT_CHAT_ID_BASE } from './agents.js';
import type { AgentQueue } from './agent-queue.js';
import {
  setupAgentFleetTools,
  DISPATCH_AGENT_TOOL_NAME,
  FLEET_STATUS_TOOL_NAME,
  MANAGE_AGENT_TASKS_TOOL_NAME,
} from './agent-fleet-tools.js';

const log = createLogger({ level: 'error', out: () => {}, err: () => {} });
const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({ log, ...over });

function fakeQueue(): AgentQueue & { notifies: number } {
  const q = { notifies: 0 } as AgentQueue & { notifies: number };
  q.notify = () => {
    q.notifies += 1;
  };
  return q;
}

function harness() {
  const home = mkdtempSync(join(tmpdir(), 'modulus-fleet-'));
  const db = open({ path: join(home, 'modulus.db'), log });
  const registry = createAgentRegistry(db);
  const tools = createToolRegistry({ log, confirm: async () => true });
  const queue = fakeQueue();
  const cancelled: number[] = [];
  const runtime = {
    cancelTask: (taskId: number): boolean => {
      cancelled.push(taskId);
      registry.updateTask(taskId, { status: 'cancelled', finishedAt: Date.now() });
      return true;
    },
  };
  setupAgentFleetTools({ tools, registry, queue, runtime, log });
  return {
    db,
    registry,
    tools,
    queue,
    cancelled,
    cleanup: () => (db.close(), rmSync(home, { recursive: true, force: true })),
  };
}

test('dispatch_agent enqueues for the named agent and pokes the queue', async () => {
  const h = harness();
  try {
    const agent = h.registry.create({ name: 'researcher', systemPrompt: 'You research.' });
    const out = await h.tools
      .get(DISPATCH_AGENT_TOOL_NAME)!
      .invoke({ agent: 'Researcher', task: 'find the best CPU LLMs' }, ctx({ chatId: 42 }));

    const tasks = h.registry.listTasks({ agentId: agent.id });
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]!.prompt, 'find the best CPU LLMs');
    assert.equal(tasks[0]!.status, 'queued');
    assert.equal(h.queue.notifies, 1);
    assert.match(out, /task #\d+ to researcher/);
  } finally {
    h.cleanup();
  }
});

test('dispatch_agent: unknown agent lists the valid roster instead of failing opaquely', async () => {
  const h = harness();
  try {
    h.registry.create({ name: 'writer', systemPrompt: 'You write.' });
    const out = await h.tools
      .get(DISPATCH_AGENT_TOOL_NAME)!
      .invoke({ agent: 'ghost', task: 'boo' }, ctx({ chatId: 1 }));
    assert.match(out, /No agent named "ghost"/);
    assert.match(out, /writer/);
    assert.equal(h.queue.notifies, 0);
  } finally {
    h.cleanup();
  }
});

test('agent_fleet_status reports per-agent counts and the latest result', async () => {
  const h = harness();
  try {
    const a = h.registry.create({ name: 'alpha', role: 'does A', systemPrompt: 'A.' });
    const b = h.registry.create({ name: 'beta', systemPrompt: 'B.' });
    h.registry.enqueue({ agentId: a.id, prompt: 'one' });
    const done = h.registry.enqueue({ agentId: a.id, prompt: 'two' });
    h.registry.updateTask(done.id, { status: 'done', result: 'all finished fine' });
    const paused = h.registry.enqueue({ agentId: b.id, prompt: 'three' });
    h.registry.updateTask(paused.id, { status: 'paused' });

    const out = await h.tools.get(FLEET_STATUS_TOOL_NAME)!.invoke({}, ctx({ chatId: 1 }));
    assert.match(out, /alpha .*does A.*1 queued/);
    assert.match(out, /Last result: all finished fine/);
    assert.match(out, /beta .*1 paused/);
  } finally {
    h.cleanup();
  }
});

test('manage_agent_tasks pauses, resumes, and cancels only the named agent', async () => {
  const h = harness();
  try {
    const a = h.registry.create({ name: 'busy', systemPrompt: 'B.' });
    const other = h.registry.create({ name: 'other', systemPrompt: 'O.' });
    const ta = h.registry.enqueue({ agentId: a.id, prompt: 'work' });
    const tOther = h.registry.enqueue({ agentId: other.id, prompt: 'other work' });
    const manage = h.tools.get(MANAGE_AGENT_TASKS_TOOL_NAME)!;
    assert.equal(manage.tier, 'confirm');

    const pausedOut = await manage.invoke({ agent: 'busy', action: 'pause' }, ctx({ chatId: 1 }));
    assert.match(pausedOut, /Paused 1 task/);
    assert.equal(h.registry.getTask(ta.id)!.status, 'paused');
    assert.equal(h.registry.getTask(tOther.id)!.status, 'queued', 'other agent untouched');

    const resumedOut = await manage.invoke({ agent: 'busy', action: 'resume' }, ctx({ chatId: 1 }));
    assert.match(resumedOut, /Resumed 1 task/);
    assert.equal(h.registry.getTask(ta.id)!.status, 'queued');
    assert.equal(h.queue.notifies, 1, 'resume must poke the queue');

    const cancelledOut = await manage.invoke({ agent: 'busy', action: 'cancel' }, ctx({ chatId: 1 }));
    assert.match(cancelledOut, /Cancelled 1 task/);
    assert.deepEqual(h.cancelled, [ta.id], 'queued/running cancels go through the runtime');
    assert.equal(h.registry.getTask(tOther.id)!.status, 'queued', 'other agent still untouched');
  } finally {
    h.cleanup();
  }
});

test('every fleet tool refuses from inside an agent chat', async () => {
  const h = harness();
  try {
    const a = h.registry.create({ name: 'solo', systemPrompt: 'S.' });
    const agentCtx = ctx({ chatId: AGENT_CHAT_ID_BASE + 9 });

    const dispatch = await h.tools
      .get(DISPATCH_AGENT_TOOL_NAME)!
      .invoke({ agent: 'solo', task: 'x' }, agentCtx);
    assert.match(dispatch, /main chat/);
    assert.equal(h.registry.listTasks({ agentId: a.id }).length, 0);

    const status = await h.tools.get(FLEET_STATUS_TOOL_NAME)!.invoke({}, agentCtx);
    assert.match(status, /main chat/);

    const manage = await h.tools
      .get(MANAGE_AGENT_TASKS_TOOL_NAME)!
      .invoke({ agent: 'solo', action: 'cancel' }, agentCtx);
    assert.match(manage, /main chat/);
  } finally {
    h.cleanup();
  }
});
