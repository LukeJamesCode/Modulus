import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../storage/db.js';
import { createLogger } from '../util/log.js';
import { createToolRegistry, type ToolContext } from './tools.js';
import { createAgentRegistry, seedStarterAgents, AGENT_CHAT_ID_BASE } from './agents.js';
import type { AgentQueue } from './agent-queue.js';
import { setupAgentEscalation, ESCALATE_TOOL_NAME } from './agent-escalation.js';

const log = createLogger({ level: 'error', out: () => {}, err: () => {} });
const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({ log, ...over });

// A queue stub that only records notify() — the escalation tool's contract is
// "enqueue then poke the queue", and we assert both halves.
function fakeQueue(): AgentQueue & { notifies: number } {
  const q = { notifies: 0 } as AgentQueue & { notifies: number };
  q.notify = () => {
    q.notifies += 1;
  };
  return q;
}

function harness() {
  const home = mkdtempSync(join(tmpdir(), 'modulus-escalate-'));
  const db = open({ path: join(home, 'modulus.db'), log });
  const registry = createAgentRegistry(db);
  seedStarterAgents(registry); // includes the autonomous `operator`
  const tools = createToolRegistry({ log, confirm: async () => false });
  const queue = fakeQueue();
  setupAgentEscalation({ tools, registry, queue, log });
  const tool = tools.get(ESCALATE_TOOL_NAME)!;
  return {
    home,
    db,
    registry,
    tools,
    queue,
    tool,
    cleanup: () => (db.close(), rmSync(home, { recursive: true, force: true })),
  };
}

test('escalation enqueues an operator task and pokes the queue', async () => {
  const h = harness();
  try {
    const operator = h.registry.getByName('operator')!;
    const before = h.registry.listTasks({ agentId: operator.id }).length;

    const out = await h.tool.invoke(
      { task: 'research X and write a long report' },
      ctx({ chatId: 42 }),
    );

    const tasks = h.registry.listTasks({ agentId: operator.id });
    assert.equal(tasks.length, before + 1, 'one operator task must be enqueued');
    // The enqueued task carries the user's goal verbatim — the operator can't
    // see the chat, so the prompt is its only context.
    assert.equal(tasks[0]!.prompt, 'research X and write a long report');
    assert.equal(tasks[0]!.status, 'queued');
    assert.equal(h.queue.notifies, 1, 'the queue must be notified so the daemon picks it up');
    // The user is told where to watch it (pairs with the instant ack).
    assert.match(out, /task #\d+/);
    assert.match(out, /Agents tab/);
  } finally {
    h.cleanup();
  }
});

test('escalation refuses from inside an agent run (agents delegate, not re-escalate)', async () => {
  const h = harness();
  try {
    const operator = h.registry.getByName('operator')!;
    const before = h.registry.listTasks({ agentId: operator.id }).length;

    const out = await h.tool.invoke(
      { task: 'do a big thing' },
      ctx({ chatId: AGENT_CHAT_ID_BASE + 5 }),
    );

    assert.match(out, /spawn_agent/);
    assert.equal(
      h.registry.listTasks({ agentId: operator.id }).length,
      before,
      'no task may be enqueued when called from an agent chat',
    );
    assert.equal(h.queue.notifies, 0);
  } finally {
    h.cleanup();
  }
});

test('escalation needs a non-empty task', async () => {
  const h = harness();
  try {
    const out = await h.tool.invoke({ task: '   ' }, ctx({ chatId: 1 }));
    assert.match(out, /required/);
    assert.equal(h.queue.notifies, 0);
  } finally {
    h.cleanup();
  }
});

test('escalation reports cleanly when no operator agent exists', async () => {
  const home = mkdtempSync(join(tmpdir(), 'modulus-escalate-'));
  const db = open({ path: join(home, 'modulus.db'), log });
  try {
    const registry = createAgentRegistry(db); // no seed → no operator
    const tools = createToolRegistry({ log, confirm: async () => false });
    setupAgentEscalation({ tools, registry, queue: fakeQueue(), log });
    const out = await tools.get(ESCALATE_TOOL_NAME)!.invoke({ task: 'x' }, ctx({ chatId: 1 }));
    assert.match(out, /No 'operator'/);
  } finally {
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
});
