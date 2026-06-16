import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../storage/db.js';
import { createAgentRegistry } from '../core/agents.js';
import { createLogger } from '../util/log.js';
import type { LLM } from '../core/llm.js';
import {
  formatAgentList,
  formatTaskNotification,
  handleAgentCommand,
  handleDispatch,
  handleDispatchWithAttachments,
  handleFire,
  handleHire,
  handleNewAgent,
} from './agent-commands.js';

const log = createLogger({ level: 'error', out: () => {}, err: () => {} });

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

// Best-effort temp cleanup. On Windows better-sqlite3's mmap keeps the .db file
// locked until GC, so an immediate unlink can EBUSY; the OS reclaims the temp
// dir regardless, so a stuck delete must not fail an otherwise-passing test.
function rmTmp(dir: string) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {
    /* ignore — OS reclaims %TEMP% */
  }
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
    rmTmp(dir);
  }
});

test('/dispatch: validates input and enqueues a task for a known agent', async () => {
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    const reg = createAgentRegistry(db);
    const agent = reg.create({ name: 'researcher', systemPrompt: 'x' });

    // Usage / error paths. Without routing deps, an unknown first token is the
    // old "no such agent" error (the auto-route path needs llm+log).
    assert.match(await handleDispatch(reg, undefined, ''), /Usage/);
    assert.match(await handleDispatch(reg, undefined, 'researcher'), /Usage/);
    assert.match(await handleDispatch(reg, undefined, 'ghost find things'), /No agent named 'ghost'/);

    // Happy path: the rest of the line becomes the task prompt.
    const reply = await handleDispatch(reg, undefined, 'researcher  find the population of Mars ');
    assert.match(reply, /Dispatched task #\d+ to researcher/);
    const tasks = reg.listTasks({ agentId: agent.id });
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]!.prompt, 'find the population of Mars');
    assert.equal(tasks[0]!.status, 'queued');
    db.close();
  } finally {
    rmTmp(dir);
  }
});

test('/dispatch records the notify chat and tells the user it will report back', async () => {
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    const reg = createAgentRegistry(db);
    const agent = reg.create({ name: 'researcher', systemPrompt: 'x' });

    // With a chat id: the task remembers it and the reply promises a ping.
    const reply = await handleDispatch(reg, undefined, 'researcher find it', 42);
    assert.match(reply, /message you when it's done/);
    assert.equal(reg.listTasks({ agentId: agent.id })[0]!.notifyChatId, 42);

    // Without one (a surface that can't deliver): no promise, nothing recorded.
    const reply2 = await handleDispatch(reg, undefined, 'researcher find it again');
    assert.doesNotMatch(reply2, /message you/);
    assert.equal(reg.listTasks({ agentId: agent.id })[0]!.notifyChatId, null); // newest first
    db.close();
  } finally {
    rmTmp(dir);
  }
});

// Routing FakeLLM: replies with a fixed agent name for the one classification
// call the auto-route path makes. Mirrors agent-router.test.ts.
function routingLlm(reply: string) {
  async function* one() {
    yield { delta: reply, done: true, model: 'fake' };
  }
  return {
    chat: () => one(),
    health: async () => ({ ok: true, models: ['fake'] }),
    listProfiles: () => ({
      chat: { model: 'fake', contextTokens: 4096, heavy: false },
      reason: null,
      tools: null,
    }),
    resolveModel: () => 'fake',
    breakerSnapshot: () => ({
      state: 'closed' as const,
      failures: 0,
      consecutiveSuccesses: 0,
      openedAt: null,
      retryAt: null,
    }),
    stopIdleEviction: () => {},
  };
}

test('/dispatch <task> (no agent named) auto-routes when routing deps are given', async () => {
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    const reg = createAgentRegistry(db);
    reg.create({
      name: 'researcher',
      role: 'Looks things up and reports the facts',
      systemPrompt: 'x',
      profile: 'tools',
    });
    const writer = reg.create({ name: 'writer', role: 'Drafts prose', systemPrompt: 'x' });
    const route = { llm: routingLlm('NONE') as unknown as LLM, log };

    // Obvious rule match → no model needed; whole line becomes the task.
    const reply = await handleDispatch(
      reg,
      undefined,
      'research the best mini-PCs for a home server',
      42,
      route,
    );
    assert.match(reply, /Sent to researcher/);
    assert.match(reply, /message you when it's done/);
    const t = reg.listTasks({})[0]!;
    assert.equal(t.prompt, 'research the best mini-PCs for a home server');
    assert.equal(t.notifyChatId, 42);
    assert.notEqual(t.agentId, writer.id);
    db.close();
  } finally {
    rmTmp(dir);
  }
});

test('/dispatch <task> with no fitting agent creates nothing and says so', async () => {
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    const reg = createAgentRegistry(db);
    // Two personas that tie on keywords → model decides; model says NONE.
    reg.create({ name: 'scout', role: 'researches topics', systemPrompt: 'x' });
    reg.create({ name: 'digger', role: 'researches facts', systemPrompt: 'x' });
    const route = { llm: routingLlm('NONE') as unknown as LLM, log };

    const reply = await handleDispatch(reg, undefined, 'research something undecidable', 42, route);
    assert.match(reply, /couldn't find a specialist/);
    assert.equal(reg.listTasks({}).length, 0);
    db.close();
  } finally {
    rmTmp(dir);
  }
});

test('task-done notification: formats done + error, skips non-terminal and cancelled', () => {
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    const reg = createAgentRegistry(db);
    const agent = reg.create({ name: 'researcher', systemPrompt: 'x' });
    const t = reg.enqueue({ agentId: agent.id, prompt: 'do it', notifyChatId: 42 });

    // Still queued — nothing to report yet.
    assert.equal(formatTaskNotification(reg.getTask(t.id)!, agent.name), null);

    reg.updateTask(t.id, { status: 'done', result: 'the answer is 7' });
    const done = formatTaskNotification(reg.getTask(t.id)!, agent.name)!;
    assert.match(done, /Task #\d+ \(researcher\) finished/);
    assert.match(done, /the answer is 7/);

    reg.updateTask(t.id, { status: 'error', error: 'model timed out' });
    assert.match(formatTaskNotification(reg.getTask(t.id)!, agent.name)!, /failed: model timed out/);

    // User-cancelled: they initiated it, so no ping.
    reg.updateTask(t.id, { status: 'cancelled', error: 'cancelled' });
    assert.equal(formatTaskNotification(reg.getTask(t.id)!, agent.name), null);
    db.close();
  } finally {
    rmTmp(dir);
  }
});

test('task-done notification: a long result is truncated to fit one message', () => {
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    const reg = createAgentRegistry(db);
    const agent = reg.create({ name: 'researcher', systemPrompt: 'x' });
    const t = reg.enqueue({ agentId: agent.id, prompt: 'do it', notifyChatId: 42 });
    reg.updateTask(t.id, { status: 'done', result: 'x'.repeat(5000) });
    const out = formatTaskNotification(reg.getTask(t.id)!, agent.name)!;
    assert.ok(out.length < 4096); // safely under the Telegram cap
    assert.match(out, /truncated/);
    db.close();
  } finally {
    rmTmp(dir);
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
    rmTmp(dir);
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
    rmTmp(dir);
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
    rmTmp(dir);
  }
});

// -- Phase 4: agent CRUD from chat ------------------------------------------

test('/hire instantiates a template (and reports a name collision)', () => {
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    const reg = createAgentRegistry(db);

    assert.match(handleHire(reg, ''), /Usage: \/hire/);
    assert.match(handleHire(reg, 'ghost'), /No template 'ghost'/);

    const ok = handleHire(reg, 'researcher');
    assert.match(ok, /Hired researcher/);
    const agent = reg.getByName('researcher')!;
    assert.equal(agent.origin, null); // user-owned
    assert.equal(agent.profile, 'tools');

    // Same default name again → collision message, no second row.
    assert.match(handleHire(reg, 'researcher'), /already exists/);
    // A name override creates a distinct agent.
    assert.match(handleHire(reg, 'researcher newsbot'), /Hired newsbot/);
    assert.ok(reg.getByName('newsbot'));
    // Bad override name is rejected.
    assert.match(handleHire(reg, 'researcher Bad Name'), /letters, numbers/);
    db.close();
  } finally {
    rmTmp(dir);
  }
});

test('/newagent creates a blank custom agent', () => {
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    const reg = createAgentRegistry(db);

    assert.match(handleNewAgent(reg, ''), /Usage/);
    assert.match(handleNewAgent(reg, 'Bad Name'), /letters, numbers/);

    const reply = handleNewAgent(reg, 'scribe');
    assert.match(reply, /Created scribe/);
    const agent = reg.getByName('scribe')!;
    assert.equal(agent.origin, null);
    assert.equal(agent.profile, 'chat');
    assert.ok(agent.systemPrompt.length > 0);

    assert.match(handleNewAgent(reg, 'scribe'), /already exists/);
    db.close();
  } finally {
    rmTmp(dir);
  }
});

test('/agent reads and updates via knobs, prompt, role', () => {
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    const reg = createAgentRegistry(db);
    reg.create({ name: 'scribe', role: 'writes', systemPrompt: 'old', profile: 'chat' });

    // Read.
    assert.match(handleAgentCommand(reg, 'scribe'), /scribe — writes/);
    assert.match(handleAgentCommand(reg, 'ghost'), /No agent named 'ghost'/);

    // set <knob> via the plain vocabulary.
    assert.match(handleAgentCommand(reg, 'scribe set brainpower deep'), /Set scribe: brainpower = deep/);
    assert.equal(reg.getByName('scribe')!.profile, 'reason');
    assert.match(handleAgentCommand(reg, 'scribe set solo on'), /Set scribe/);
    assert.equal(reg.getByName('scribe')!.mode, 'autonomous');

    // prompt + role.
    assert.match(handleAgentCommand(reg, 'scribe prompt You write crisp notes.'), /Updated scribe's prompt/);
    assert.equal(reg.getByName('scribe')!.systemPrompt, 'You write crisp notes.');
    assert.match(handleAgentCommand(reg, 'scribe role takes notes'), /Updated scribe's role/);
    assert.equal(reg.getByName('scribe')!.role, 'takes notes');

    // Bad knob + usage.
    assert.match(handleAgentCommand(reg, 'scribe set turbo on'), /Unknown setting 'turbo'/);
    assert.match(handleAgentCommand(reg, 'scribe set brainpower'), /Usage: \/agent scribe set/);
    assert.match(handleAgentCommand(reg, 'scribe wat'), /Unknown command 'wat'/);
    db.close();
  } finally {
    rmTmp(dir);
  }
});

test('/fire removes a user agent; module-owned agents reject edit and delete', () => {
  const dir = tmp();
  try {
    const db = open({ path: join(dir, 'g.db') });
    const reg = createAgentRegistry(db);
    const user = reg.create({ name: 'scribe', systemPrompt: 'x' });
    reg.create({ name: 'modbot', systemPrompt: 'x', origin: 'module:modulus-demo' });

    // Module-owned: read works, but every mutation is refused.
    assert.match(handleAgentCommand(reg, 'modbot'), /modbot/);
    assert.match(handleAgentCommand(reg, 'modbot set brainpower deep'), /can't be edited or removed/);
    assert.match(handleAgentCommand(reg, 'modbot prompt nope'), /can't be edited or removed/);
    assert.match(handleFire(reg, 'modbot'), /can't be edited or removed/);
    assert.ok(reg.getByName('modbot'), 'module agent survives a fire attempt');

    // User-owned: fire deletes it.
    assert.match(handleFire(reg, 'scribe'), /Fired scribe/);
    assert.equal(reg.get(user.id), undefined);
    assert.match(handleFire(reg, 'ghost'), /No agent named 'ghost'/);
    db.close();
  } finally {
    rmTmp(dir);
  }
});
