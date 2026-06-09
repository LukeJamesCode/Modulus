import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../storage/db.js';
import { createAgentRegistry } from '../core/agents.js';
import {
  formatAgentList,
  handleDispatch,
  handleDispatchWithAttachments,
} from './agent-commands.js';

// Minimal LLM stub: only resolveModel + supportsVision are read by the
// attachment dispatch path. `vision` toggles the multimodal gate.
function fakeLlm(vision: boolean) {
  return {
    resolveModel: () => 'qwen3:8b',
    supportsVision: async () => vision,
  };
}

function tmp() {
  return mkdtempSync(join(tmpdir(), 'modulus-agentcmd-'));
}

test('/agents: lists personas, or guides the user when there are none', () => {
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    const reg = createAgentRegistry(db);
    assert.match(formatAgentList(reg), /No agents defined/);

    reg.create({
      name: 'planner',
      role: 'plans',
      systemPrompt: 'x',
      profile: 'reason',
      canDelegate: true,
    });
    const out = formatAgentList(reg);
    assert.match(out, /planner — plans \(reason\)/);
    assert.match(out, /delegates/);
    assert.match(out, /\/dispatch <agent> <task>/);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('/dispatch: validates input and enqueues a task for a known agent', () => {
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    const reg = createAgentRegistry(db);
    const agent = reg.create({ name: 'researcher', systemPrompt: 'x' });

    // Usage / error paths.
    assert.match(handleDispatch(reg, undefined, ''), /Usage/);
    assert.match(handleDispatch(reg, undefined, 'researcher'), /Usage/);
    assert.match(handleDispatch(reg, undefined, 'ghost find things'), /No agent named 'ghost'/);

    // Happy path: the rest of the line becomes the task prompt.
    const reply = handleDispatch(reg, undefined, 'researcher  find the population of Mars ');
    assert.match(reply, /Dispatched task #\d+ to researcher/);
    const tasks = reg.listTasks({ agentId: agent.id });
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]!.prompt, 'find the population of Mars');
    assert.equal(tasks[0]!.status, 'queued');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('/dispatch with attachments: text-only model takes the file, refuses the image', async () => {
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    const reg = createAgentRegistry(db);
    const agent = reg.create({ name: 'researcher', systemPrompt: 'x' });
    const baseDir = join(dir, 'attachments');

    const reply = await handleDispatchWithAttachments({
      registry: reg,
      queue: undefined,
      llm: fakeLlm(false),
      baseDir,
      arg: 'researcher read these notes',
      files: [
        { name: 'notes.txt', bytes: Buffer.from('hello') },
        { name: 'shot.png', bytes: Buffer.from([0x89, 0x50]), mime: 'image/png' },
      ],
    });

    // One task, prompt is the caption tail, the text file landed, image refused.
    assert.match(reply, /Dispatched task #\d+ to researcher with 1 attachment\b/);
    assert.match(reply, /Skipped:.*shot\.png.*multimodal/);
    const tasks = reg.listTasks({ agentId: agent.id });
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]!.prompt, 'read these notes');
    const kinds = reg.listAttachments(tasks[0]!.id).map((a) => a.kind);
    assert.deepEqual(kinds, ['file']);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('/dispatch with attachments: multimodal model accepts the image', async () => {
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    const reg = createAgentRegistry(db);
    const agent = reg.create({ name: 'looker', systemPrompt: 'x' });

    const reply = await handleDispatchWithAttachments({
      registry: reg,
      queue: undefined,
      llm: fakeLlm(true),
      baseDir: join(dir, 'attachments'),
      arg: 'looker what is in this picture',
      files: [{ name: 'shot.png', bytes: Buffer.from([0x89, 0x50]), mime: 'image/png' }],
    });

    assert.match(reply, /with 1 attachment\b/);
    assert.doesNotMatch(reply, /Skipped/);
    const task = reg.listTasks({ agentId: agent.id })[0]!;
    assert.deepEqual(
      reg.listAttachments(task.id).map((a) => a.kind),
      ['image'],
    );
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('/dispatch with attachments: usage + unknown-agent errors enqueue nothing', async () => {
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    const reg = createAgentRegistry(db);
    const common = {
      registry: reg,
      queue: undefined,
      llm: fakeLlm(true),
      baseDir: join(dir, 'attachments'),
      files: [{ name: 'a.txt', bytes: Buffer.from('x') }],
    };
    assert.match(await handleDispatchWithAttachments({ ...common, arg: 'researcher' }), /Usage/);
    assert.match(
      await handleDispatchWithAttachments({ ...common, arg: 'ghost do it' }),
      /No agent named 'ghost'/,
    );
    assert.equal(reg.listTasks({}).length, 0);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
