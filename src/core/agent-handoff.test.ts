import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../storage/db.js';
import { createLogger } from '../util/log.js';
import { createToolRegistry, type ToolHandler, type ToolContext } from './tools.js';
import { createAgentRegistry, AGENT_CHAT_ID_BASE, MAX_DELEGATION_DEPTH } from './agents.js';
import { createConversationRouter } from './conversation-routing.js';
import {
  setupAgentHandoff,
  setupTaskHandoff,
  HANDOFF_TOOL_NAME,
  HANDOFF_TASK_TOOL_NAME,
} from './agent-handoff.js';
import type { Orchestrator } from './orchestrator.js';

const silentLog = () => createLogger({ out: () => {}, err: () => {} });
const fakeOrch = (): Orchestrator => ({
  handleUserMessage: async () => {},
  stop: () => false,
  newChat: () => {},
  lastError: () => undefined,
  shutdown: async () => {},
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'modulus-handoff-'));
  const db = open({ path: join(dir, 'g.db') });
  const log = silentLog();
  const registry = createAgentRegistry(db);
  const router = createConversationRouter({
    db,
    registry,
    log,
    defaultOrchestrator: fakeOrch(),
    orchestratorFactory: () => fakeOrch(),
  });
  const tools = createToolRegistry({ log });
  let clock = 1000;
  setupAgentHandoff({ tools, router, registry, log, now: () => clock });
  const handoff = tools.get(HANDOFF_TOOL_NAME)!;
  const ctx = (chatId: number): ToolContext => ({ chatId, log });
  return {
    db,
    registry,
    router,
    handoff,
    ctx,
    setClock: (n: number) => {
      clock = n;
    },
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const run = (h: ToolHandler, args: Record<string, unknown>, ctx: ToolContext) =>
  h.invoke(args, ctx);

test('handoff is auto-tier and self-replying', () => {
  const { handoff, cleanup } = setup();
  try {
    assert.equal(handoff.tier, 'auto');
    assert.equal(handoff.selfReplying, true);
  } finally {
    cleanup();
  }
});

test('handoff binds the chat to the target and announces it', async () => {
  const { registry, router, handoff, ctx, cleanup } = setup();
  try {
    const coder = registry.create({ name: 'coder', systemPrompt: 'write code' });
    const out = await run(handoff, { agent: 'coder', note: 'they need a python script' }, ctx(42));
    assert.match(out, /Handing you over to coder/);
    assert.match(out, /python script/);
    assert.equal(router.boundAgentId(42), coder.id);
    assert.equal(router.binding(42)!.setBy, 'handoff:assistant');
  } finally {
    cleanup();
  }
});

test('handoff to an unknown agent does nothing', async () => {
  const { router, handoff, ctx, cleanup } = setup();
  try {
    const out = await run(handoff, { agent: 'ghost' }, ctx(42));
    assert.match(out, /No agent named 'ghost'/);
    assert.equal(router.boundAgentId(42), null);
  } finally {
    cleanup();
  }
});

test('handoff is refused inside a background agent task run', async () => {
  const { registry, handoff, ctx, router, cleanup } = setup();
  try {
    registry.create({ name: 'coder', systemPrompt: 'x' });
    const taskChat = AGENT_CHAT_ID_BASE + 5;
    const out = await run(handoff, { agent: 'coder' }, ctx(taskChat));
    assert.match(out, /delegate with spawn_agent/);
    assert.equal(router.boundAgentId(taskChat), null);
  } finally {
    cleanup();
  }
});

test('a bound caller may only hand off within its delegatableAgents allowlist', async () => {
  const { registry, router, handoff, ctx, cleanup } = setup();
  try {
    const triage = registry.create({
      name: 'triage',
      systemPrompt: 'route requests',
      delegatableAgents: ['coder'],
    });
    registry.create({ name: 'coder', systemPrompt: 'x' });
    registry.create({ name: 'researcher', systemPrompt: 'x' });
    // The chat is currently driven by triage.
    router.bind(42, triage.id, 'user');

    const denied = await run(handoff, { agent: 'researcher' }, ctx(42));
    assert.match(denied, /may not hand off to 'researcher'/);
    assert.equal(router.boundAgentId(42), triage.id, 'denied handoff leaves the binding');

    const ok = await run(handoff, { agent: 'coder' }, ctx(42));
    assert.match(ok, /Handing you over to coder/);
    assert.equal(router.binding(42)!.setBy, 'handoff:triage');
  } finally {
    cleanup();
  }
});

test('handing off to the agent already on the chat is a no-op', async () => {
  const { registry, router, handoff, ctx, cleanup } = setup();
  try {
    const coder = registry.create({ name: 'coder', systemPrompt: 'x' });
    router.bind(42, coder.id, 'user');
    const out = await run(handoff, { agent: 'coder' }, ctx(42));
    assert.match(out, /already the agent/);
    assert.equal(router.binding(42)!.setBy, 'user', 'unchanged');
  } finally {
    cleanup();
  }
});

test('the ping-pong cap refuses too many handoffs in the window', async () => {
  const { registry, router, handoff, ctx, setClock, cleanup } = setup();
  try {
    registry.create({ name: 'a', systemPrompt: 'x' });
    registry.create({ name: 'b', systemPrompt: 'x' });
    // 3 handoffs in the window are allowed; the 4th is refused.
    setClock(1000);
    assert.match(await run(handoff, { agent: 'a' }, ctx(42)), /Handing you over/);
    setClock(1100);
    assert.match(await run(handoff, { agent: 'b' }, ctx(42)), /Handing you over/);
    setClock(1200);
    assert.match(await run(handoff, { agent: 'a' }, ctx(42)), /Handing you over/);
    setClock(1300);
    const refused = await run(handoff, { agent: 'b' }, ctx(42));
    assert.match(refused, /Too many handoffs/);
    assert.equal(router.boundAgentId(42), registry.getByName('a')!.id, 'stayed put');

    // Past the window, handoff works again.
    setClock(1000 + 61_000);
    assert.match(await run(handoff, { agent: 'b' }, ctx(42)), /Handing you over/);
  } finally {
    cleanup();
  }
});

// ---- handoff_task (background-run handoff) ----------------------------------

function setupTask() {
  const dir = mkdtempSync(join(tmpdir(), 'modulus-handofftask-'));
  const db = open({ path: join(dir, 'g.db') });
  const log = silentLog();
  const registry = createAgentRegistry(db);
  const tools = createToolRegistry({ log });
  let notified = 0;
  const queue = { notify: () => void notified++ } as unknown as Parameters<
    typeof setupTaskHandoff
  >[0]['queue'];
  setupTaskHandoff({ tools, registry, queue, log });
  const tool = tools.get(HANDOFF_TASK_TOOL_NAME)!;
  const ctx = (chatId: number): ToolContext => ({ chatId, log });
  return {
    registry,
    tool,
    ctx,
    notified: () => notified,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// Enqueue a task for an agent and return the agent-run chatId that drives it.
function runningTaskChat(
  registry: ReturnType<typeof createAgentRegistry>,
  agentId: number,
  extra: { depth?: number; notifyChatId?: number } = {},
): number {
  const task = registry.enqueue({
    agentId,
    prompt: 'do the thing',
    ...(extra.depth !== undefined ? { depth: extra.depth } : {}),
    ...(extra.notifyChatId !== undefined ? { notifyChatId: extra.notifyChatId } : {}),
  });
  return AGENT_CHAT_ID_BASE + task.id;
}

test('handoff_task enqueues a successor for the target and notifies the queue', async () => {
  const { registry, tool, ctx, notified, cleanup } = setupTask();
  try {
    const caller = registry.create({ name: 'triage', systemPrompt: 'x' });
    const target = registry.create({ name: 'coder', systemPrompt: 'x' });
    const chat = runningTaskChat(registry, caller.id, { notifyChatId: 99 });

    const out = await run(tool, { agent: 'coder', task: 'write the script' }, ctx(chat));
    assert.match(out, /Handed this task to coder as task #\d+/);
    assert.equal(notified(), 1);

    const successors = registry.listTasks({ agentId: target.id });
    assert.equal(successors.length, 1);
    assert.equal(successors[0]!.prompt, 'write the script');
    assert.equal(successors[0]!.depth, 1, 'depth+1 bounds handoff chains');
    assert.equal(successors[0]!.notifyChatId, 99, 'carries the original notify chat');
  } finally {
    cleanup();
  }
});

test('handoff_task carries the caller grant ceiling so it cannot escalate', async () => {
  const { registry, tool, ctx, cleanup } = setupTask();
  try {
    const caller = registry.create({
      name: 'scoped',
      systemPrompt: 'x',
      toolAllowlist: ['modulus-fs'],
    });
    const target = registry.create({ name: 'coder', systemPrompt: 'x' });
    const chat = runningTaskChat(registry, caller.id);
    await run(tool, { agent: 'coder', task: 'go' }, ctx(chat));
    const successor = registry.listTasks({ agentId: target.id })[0]!;
    assert.deepEqual(successor.toolAllowlistOverride, ['modulus-fs']);
  } finally {
    cleanup();
  }
});

test('handoff_task is refused outside an agent run', async () => {
  const { registry, tool, ctx, cleanup } = setupTask();
  try {
    registry.create({ name: 'coder', systemPrompt: 'x' });
    const out = await run(tool, { agent: 'coder', task: 'go' }, ctx(42));
    assert.match(out, /only be used from within an agent run/);
  } finally {
    cleanup();
  }
});

test('handoff_task refuses an unknown target, self, and a disallowed peer', async () => {
  const { registry, tool, ctx, cleanup } = setupTask();
  try {
    const caller = registry.create({
      name: 'triage',
      systemPrompt: 'x',
      delegatableAgents: ['coder'],
    });
    registry.create({ name: 'coder', systemPrompt: 'x' });
    registry.create({ name: 'researcher', systemPrompt: 'x' });
    const chat = runningTaskChat(registry, caller.id);

    assert.match(
      await run(tool, { agent: 'ghost', task: 'go' }, ctx(chat)),
      /No agent named 'ghost'/,
    );
    assert.match(await run(tool, { agent: 'triage', task: 'go' }, ctx(chat)), /That's you/);
    assert.match(
      await run(tool, { agent: 'researcher', task: 'go' }, ctx(chat)),
      /may not hand off to 'researcher'/,
    );
    // None of the refusals enqueued anything.
    assert.equal(registry.listTasks({}).filter((t) => t.prompt === 'go').length, 0);
  } finally {
    cleanup();
  }
});

test('handoff_task refuses past the depth cap', async () => {
  const { registry, tool, ctx, cleanup } = setupTask();
  try {
    const caller = registry.create({ name: 'triage', systemPrompt: 'x' });
    registry.create({ name: 'coder', systemPrompt: 'x' });
    // At the cap, no further chaining.
    const chat = runningTaskChat(registry, caller.id, { depth: MAX_DELEGATION_DEPTH });
    assert.match(await run(tool, { agent: 'coder', task: 'go' }, ctx(chat)), /depth limit/);
  } finally {
    cleanup();
  }
});
