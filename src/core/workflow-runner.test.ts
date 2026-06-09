import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../storage/db.js';
import { createLogger } from '../util/log.js';
import { createToolRegistry, type ToolRegistry } from './tools.js';
import type { AgentRegistry, AgentRuntime } from './agents.js';
import {
  createWorkflowRegistry,
  seedStarterWorkflows,
  CODE_REVIEW_WORKFLOW_NAME,
  type WorkflowGraph,
  type WorkflowRegistry,
} from './workflows.js';
import { createWorkflowRunner, type WorkflowRunner } from './workflow-runner.js';
import { createAgentRegistry } from './agents.js';

function silentLogger() {
  return createLogger({ level: 'error', out: () => {}, err: () => {} });
}

function tmp() {
  return mkdtempSync(join(tmpdir(), 'modulus-wfrun-'));
}

interface Harness {
  reg: WorkflowRegistry;
  tools: ToolRegistry;
  runner: WorkflowRunner;
  enqueued: Array<{ id: number; agentId: number; prompt: string }>;
  releaseHeavyCalls(): number;
  close(): void;
}

// Wire a runner against a real WorkflowRegistry (temp DB) + real ToolRegistry,
// with fake agents/runtime so tests stay deterministic and offline.
function harness(
  opts: {
    agentReply?: (prompt: string) => { ok: boolean; text: string; error?: string };
  } = {},
): Harness {
  const dir = tmp();
  const db = open({ path: join(dir, 't.db'), log: silentLogger() });
  const reg = createWorkflowRegistry(db);
  const tools = createToolRegistry({ log: silentLogger() });

  const enqueued: Array<{ id: number; agentId: number; prompt: string }> = [];
  let nextTaskId = 1000;
  const agents = {
    get: (id: number) => (id === 1 ? { id: 1, name: 'researcher' } : undefined),
    enqueue: (input: { agentId: number; prompt: string }) => {
      const task = { id: nextTaskId++, agentId: input.agentId, prompt: input.prompt };
      enqueued.push(task);
      return task;
    },
  } as unknown as AgentRegistry;

  const reply: (prompt: string) => { ok: boolean; text: string; error?: string } =
    opts.agentReply ?? ((p: string) => ({ ok: true, text: `RESULT(${p})` }));
  const runtime = {
    runTask: async (taskId: number) => {
      const task = enqueued.find((t) => t.id === taskId)!;
      const r = reply(task.prompt);
      return { ok: r.ok, text: r.text, error: r.error, conversationId: 0 };
    },
  } as unknown as AgentRuntime;

  let releaseHeavyCalls = 0;
  const llm = {
    releaseHeavy: async () => {
      releaseHeavyCalls++;
    },
  } as unknown as import('./llm.js').LLM;

  const runner = createWorkflowRunner({
    registry: reg,
    agents,
    runtime,
    tools,
    llm,
    log: silentLogger(),
    ownerUserId: 1,
  });
  return {
    reg,
    tools,
    runner,
    enqueued,
    releaseHeavyCalls: () => releaseHeavyCalls,
    close: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('linear trigger->transform->output flows input through and records every step', async () => {
  const h = harness();
  try {
    const graph: WorkflowGraph = {
      nodes: [
        { id: 't1', type: 'trigger', pos: { x: 0, y: 0 }, config: {} },
        {
          id: 'm1',
          type: 'transform',
          pos: { x: 1, y: 0 },
          config: { template: 'Hi {{trigger.input}}', as: 'text' },
        },
        {
          id: 'o1',
          type: 'output',
          pos: { x: 2, y: 0 },
          config: { channel: 'none', template: '{{steps.m1.text}}' },
        },
      ],
      edges: [
        { from: 't1', to: 'm1' },
        { from: 'm1', to: 'o1' },
      ],
    };
    const wf = h.reg.create({ name: 'demo', graph });
    const run = h.reg.enqueueRun(wf.id, 'world');
    assert.equal(await h.runner.runOnce(), true);

    const done = h.reg.getRun(run.id)!;
    assert.equal(done.status, 'done');
    assert.equal(done.output, 'Hi world');
    const steps = h.reg.listStepRuns(run.id);
    assert.equal(steps.length, 3);
    assert.ok(steps.every((s) => s.status === 'done'));
    assert.equal(steps.find((s) => s.nodeId === 'm1')!.output, 'Hi world');
  } finally {
    h.close();
  }
});

test('agent node enqueues a task, runs it, and links the agent_task_id', async () => {
  const h = harness({ agentReply: (p) => ({ ok: true, text: `RESULT(${p})` }) });
  try {
    const graph: WorkflowGraph = {
      nodes: [
        { id: 't1', type: 'trigger', pos: { x: 0, y: 0 }, config: {} },
        {
          id: 'a1',
          type: 'agent',
          pos: { x: 1, y: 0 },
          config: { agentId: 1, promptTemplate: 'Research {{trigger.input}}' },
        },
        {
          id: 'o1',
          type: 'output',
          pos: { x: 2, y: 0 },
          config: { channel: 'none', template: '{{steps.a1.output}}' },
        },
      ],
      edges: [
        { from: 't1', to: 'a1' },
        { from: 'a1', to: 'o1' },
      ],
    };
    const wf = h.reg.create({ name: 'agentflow', graph });
    const run = h.reg.enqueueRun(wf.id, 'CPUs');
    await h.runner.runOnce();

    assert.equal(h.enqueued.length, 1);
    assert.equal(h.enqueued[0]!.prompt, 'Research CPUs');
    const done = h.reg.getRun(run.id)!;
    assert.equal(done.output, 'RESULT(Research CPUs)');
    const a1Step = h.reg.listStepRuns(run.id).find((s) => s.nodeId === 'a1')!;
    assert.equal(a1Step.agentTaskId, h.enqueued[0]!.id);
  } finally {
    h.close();
  }
});

test('a finished run with no more queued work unloads the heavy model', async () => {
  // WHY: a workflow's agent nodes can load the 9b; once the run finishes and the
  // queue is empty, the runner frees it ASAP instead of waiting out keep_alive.
  const h = harness();
  try {
    const graph: WorkflowGraph = {
      nodes: [
        { id: 't1', type: 'trigger', pos: { x: 0, y: 0 }, config: {} },
        {
          id: 'a1',
          type: 'agent',
          pos: { x: 1, y: 0 },
          config: { agentId: 1, promptTemplate: '{{trigger.input}}' },
        },
      ],
      edges: [{ from: 't1', to: 'a1' }],
    };
    const wf = h.reg.create({ name: 'rel', graph });
    h.reg.enqueueRun(wf.id, 'go');
    await h.runner.runOnce();
    assert.equal(h.releaseHeavyCalls(), 1, 'heavy model released once the run queue drained');
  } finally {
    h.close();
  }
});

test('a finished run does not unload while another run is still queued', async () => {
  // No churn between back-to-back runs: the resident model is freed only after
  // the LAST queued run, so a burst reuses it instead of cold-reloading each time.
  const h = harness();
  try {
    const graph: WorkflowGraph = {
      nodes: [{ id: 't1', type: 'trigger', pos: { x: 0, y: 0 }, config: {} }],
      edges: [],
    };
    const wf = h.reg.create({ name: 'rel2', graph });
    h.reg.enqueueRun(wf.id, 'a');
    h.reg.enqueueRun(wf.id, 'b');
    await h.runner.runOnce(); // first run; second still queued
    assert.equal(h.releaseHeavyCalls(), 0, 'must not release while work remains');
    await h.runner.runOnce(); // second run; queue now empty
    assert.equal(h.releaseHeavyCalls(), 1, 'release after the last run drains');
  } finally {
    h.close();
  }
});

test('tool node executes through the registry with resolved args (types preserved)', async () => {
  const h = harness();
  try {
    h.tools.register({
      name: 'echo',
      description: 'echo args',
      tier: 'auto',
      parameters: { type: 'object', properties: {} },
      skipValidation: true,
      invoke: async (args) => JSON.stringify(args),
    });
    const graph: WorkflowGraph = {
      nodes: [
        { id: 't1', type: 'trigger', pos: { x: 0, y: 0 }, config: {} },
        {
          id: 'x1',
          type: 'tool',
          pos: { x: 1, y: 0 },
          config: { tool: 'echo', args: { q: '{{trigger.input}}', n: 3 } },
        },
        {
          id: 'o1',
          type: 'output',
          pos: { x: 2, y: 0 },
          config: { channel: 'none', template: '{{steps.x1.output}}' },
        },
      ],
      edges: [
        { from: 't1', to: 'x1' },
        { from: 'x1', to: 'o1' },
      ],
    };
    const wf = h.reg.create({ name: 'toolflow', graph });
    const run = h.reg.enqueueRun(wf.id, 'hello');
    await h.runner.runOnce();
    const out = JSON.parse(h.reg.getRun(run.id)!.output!);
    assert.equal(out.q, 'hello'); // whole-token string resolved
    assert.equal(out.n, 3); // literal number preserved (not stringified)
  } finally {
    h.close();
  }
});

test('condition node runs only the matching branch; the other is pruned (no step row)', async () => {
  const h = harness();
  try {
    const graph: WorkflowGraph = {
      nodes: [
        { id: 't1', type: 'trigger', pos: { x: 0, y: 0 }, config: {} },
        {
          id: 'c1',
          type: 'condition',
          pos: { x: 1, y: 0 },
          config: { left: '{{trigger.input}}', op: 'contains', right: 'urgent' },
        },
        { id: 'mTrue', type: 'transform', pos: { x: 2, y: 0 }, config: { template: 'URGENT' } },
        { id: 'mFalse', type: 'transform', pos: { x: 2, y: 1 }, config: { template: 'normal' } },
        {
          id: 'o1',
          type: 'output',
          pos: { x: 3, y: 0 },
          config: { channel: 'none', template: '{{steps.mTrue.output}}{{steps.mFalse.output}}' },
        },
      ],
      edges: [
        { from: 't1', to: 'c1' },
        { from: 'c1', to: 'mTrue', branch: 'true' },
        { from: 'c1', to: 'mFalse', branch: 'false' },
        { from: 'mTrue', to: 'o1' },
        { from: 'mFalse', to: 'o1' },
      ],
    };
    const wf = h.reg.create({ name: 'branchflow', graph });
    const run = h.reg.enqueueRun(wf.id, 'this is urgent');
    await h.runner.runOnce();

    const steps = h.reg.listStepRuns(run.id);
    assert.ok(steps.some((s) => s.nodeId === 'mTrue'));
    assert.ok(!steps.some((s) => s.nodeId === 'mFalse')); // pruned branch
    assert.equal(h.reg.getRun(run.id)!.output, 'URGENT');
  } finally {
    h.close();
  }
});

test('loop node runs the body once per item and aggregates outputs', async () => {
  const h = harness();
  try {
    const graph: WorkflowGraph = {
      nodes: [
        { id: 't1', type: 'trigger', pos: { x: 0, y: 0 }, config: {} },
        {
          id: 'l1',
          type: 'loop',
          pos: { x: 1, y: 0 },
          config: {
            items: '{{trigger.input}}',
            body: { type: 'transform', config: { template: 'item={{item}}' } },
          },
        },
        {
          id: 'o1',
          type: 'output',
          pos: { x: 2, y: 0 },
          config: { channel: 'none', template: '{{steps.l1.output}}' },
        },
      ],
      edges: [
        { from: 't1', to: 'l1' },
        { from: 'l1', to: 'o1' },
      ],
    };
    const wf = h.reg.create({ name: 'loopflow', graph });
    const run = h.reg.enqueueRun(wf.id, 'a\nb\nc');
    await h.runner.runOnce();
    assert.deepEqual(JSON.parse(h.reg.getRun(run.id)!.output!), ['item=a', 'item=b', 'item=c']);
  } finally {
    h.close();
  }
});

test('a failing node fails the run and halts downstream execution', async () => {
  const h = harness({ agentReply: () => ({ ok: false, text: '', error: 'boom' }) });
  try {
    const graph: WorkflowGraph = {
      nodes: [
        { id: 't1', type: 'trigger', pos: { x: 0, y: 0 }, config: {} },
        {
          id: 'a1',
          type: 'agent',
          pos: { x: 1, y: 0 },
          config: { agentId: 1, promptTemplate: 'go' },
        },
        {
          id: 'o1',
          type: 'output',
          pos: { x: 2, y: 0 },
          config: { channel: 'none', template: 'never' },
        },
      ],
      edges: [
        { from: 't1', to: 'a1' },
        { from: 'a1', to: 'o1' },
      ],
    };
    const wf = h.reg.create({ name: 'failflow', graph });
    const run = h.reg.enqueueRun(wf.id, 'x');
    await h.runner.runOnce();

    const done = h.reg.getRun(run.id)!;
    assert.equal(done.status, 'error');
    assert.ok(done.error!.includes('boom'));
    const steps = h.reg.listStepRuns(run.id);
    assert.equal(steps.find((s) => s.nodeId === 'a1')!.status, 'error');
    assert.ok(!steps.some((s) => s.nodeId === 'o1')); // downstream halted
  } finally {
    h.close();
  }
});

test('cancellation between nodes stops the walk', async () => {
  const h = harness();
  try {
    let currentRunId = 0;
    h.tools.register({
      name: 'cancel_self',
      description: 'cancels the active run',
      tier: 'auto',
      parameters: { type: 'object', properties: {} },
      skipValidation: true,
      invoke: async () => {
        h.reg.updateRun(currentRunId, { status: 'cancelled', finishedAt: Date.now() });
        return 'cancelled';
      },
    });
    const graph: WorkflowGraph = {
      nodes: [
        { id: 't1', type: 'trigger', pos: { x: 0, y: 0 }, config: {} },
        { id: 'x1', type: 'tool', pos: { x: 1, y: 0 }, config: { tool: 'cancel_self', args: {} } },
        {
          id: 'after',
          type: 'transform',
          pos: { x: 2, y: 0 },
          config: { template: 'should not run' },
        },
      ],
      edges: [
        { from: 't1', to: 'x1' },
        { from: 'x1', to: 'after' },
      ],
    };
    const wf = h.reg.create({ name: 'cancelflow', graph });
    const run = h.reg.enqueueRun(wf.id, 'x');
    currentRunId = h.reg.claimNextQueuedRun()!.id;
    await h.runner.executeRun(run.id);

    assert.equal(h.reg.getRun(run.id)!.status, 'cancelled');
    assert.ok(!h.reg.listStepRuns(run.id).some((s) => s.nodeId === 'after'));
  } finally {
    h.close();
  }
});

test('a run with a stage token ingests the uploaded batch into each agent-node task', async () => {
  // WHY: uploading files to a workflow run must make them visible to the run's
  // agents — the runner ingests the staged batch into every agent node's task
  // (so read_file/list_dir pin to them) and cleans the batch up when the run ends.
  const dir = tmp();
  const db = open({ path: join(dir, 't.db'), log: silentLogger() });
  try {
    const reg = createWorkflowRegistry(db);
    const agents = createAgentRegistry(db);
    const tools = createToolRegistry({ log: silentLogger() });
    const agent = agents.create({ name: 'reader', systemPrompt: 's', toolAllowlist: [] });

    const attachmentsDir = join(dir, 'agent-attachments');
    const token = 'wfbatch1';
    const staging = join(attachmentsDir, 'staging', token);
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(staging, 'spec.md'), '# Spec\nbuild the thing');

    const runtime = {
      runTask: async (taskId: number) => {
        agents.updateTask(taskId, { status: 'done', result: 'ok' });
        return { ok: true, text: 'ok', conversationId: 0 };
      },
    } as unknown as Parameters<typeof createWorkflowRunner>[0]['runtime'];

    const runner = createWorkflowRunner({
      registry: reg,
      agents,
      runtime,
      tools,
      log: silentLogger(),
      ownerUserId: 1,
      attachmentsDir,
    });

    const graph: WorkflowGraph = {
      nodes: [
        { id: 't1', type: 'trigger', pos: { x: 0, y: 0 }, config: {} },
        {
          id: 'a1',
          type: 'agent',
          pos: { x: 1, y: 0 },
          config: { agentId: agent.id, promptTemplate: 'go' },
        },
      ],
      edges: [{ from: 't1', to: 'a1' }],
    };
    const wf = reg.create({ name: 'ingestflow', graph });
    reg.enqueueRun(wf.id, null, token);
    await runner.runOnce();

    const task = agents.listTasks()[0]!;
    const atts = agents.listAttachments(task.id);
    assert.equal(atts.length, 1);
    assert.equal(atts[0]!.name, 'spec.md');
    // The batch is removed once the run drains (single cleanup, not per node).
    assert.equal(existsSync(staging), false);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('seeded Code Review Pipeline runs end to end: loop fans over PRs, gate routes blockers', async () => {
  // Drives the *actual* bundled example against a real AgentRegistry (so the
  // node agentIds resolve) and a fake runtime, proving the graph the user opens
  // in the builder executes: one agent task per PR line, an auditor pass, the
  // condition gate, and the matching output.
  const dir = tmp();
  const db = open({ path: join(dir, 't.db'), log: silentLogger() });
  try {
    const reg = createWorkflowRegistry(db);
    const agents = createAgentRegistry(db);
    const tools = createToolRegistry({ log: silentLogger() });
    seedStarterWorkflows(reg, agents);

    // Fake runtime: the auditor (its prompt asks to "audit the codebase")
    // returns a finding tagged BLOCKER so the gate takes the 'true' branch.
    const runtime = {
      runTask: async (taskId: number) => {
        const task = agents.getTask(taskId)!;
        const text = /audit the codebase/.test(task.prompt)
          ? 'Findings:\n- BLOCKER: null deref in foo.ts'
          : `Reviewed ${task.prompt} — LGTM`;
        agents.updateTask(taskId, { status: 'done', result: text });
        return { ok: true, text, conversationId: 0 };
      },
    } as unknown as Parameters<typeof createWorkflowRunner>[0]['runtime'];

    const outputs: Array<{ channel: string; text: string }> = [];
    const runner = createWorkflowRunner({
      registry: reg,
      agents,
      runtime,
      tools,
      log: silentLogger(),
      ownerUserId: 1,
      onOutput: (channel, text) => {
        outputs.push({ channel, text });
      },
    });

    const wf = reg.list().find((w) => w.name === CODE_REVIEW_WORKFLOW_NAME)!;
    const run = reg.enqueueRun(wf.id, 'https://example/pr/1\nhttps://example/pr/2');
    assert.equal(await runner.runOnce(), true);

    const done = reg.getRun(run.id)!;
    assert.equal(done.status, 'done');
    // Loop ran the reviewer once per PR line; the auditor ran once → 3 tasks.
    assert.equal(agents.listTasks().length, 3);
    // Gate matched BLOCKER → 'report' output ran, 'clear' was pruned.
    const steps = reg.listStepRuns(run.id);
    assert.ok(steps.some((s) => s.nodeId === 'report' && s.status === 'done'));
    assert.ok(!steps.some((s) => s.nodeId === 'clear'));
    assert.equal(outputs.length, 1);
    assert.equal(outputs[0]!.channel, 'telegram');
    assert.ok(outputs[0]!.text.includes('blockers'));
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
