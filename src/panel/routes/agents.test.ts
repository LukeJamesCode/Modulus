import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { open, type DB } from '../../storage/db.js';
import { createLogger } from '../../util/log.js';
import { createAgentRegistry } from '../../core/agents.js';
import {
  createConversationRouter,
  type ConversationRouter,
} from '../../core/conversation-routing.js';
import type { Orchestrator } from '../../core/orchestrator.js';
import type { PanelDeps } from '../types.js';
import { createAgentRoutes } from './agents.js';

const log = createLogger({ level: 'error', out: () => {}, err: () => {} });

// A do-nothing orchestrator — binding routes never run a turn.
const fakeOrchestrator = (): Orchestrator => ({
  handleUserMessage: async () => {},
  stop: () => false,
  newChat: () => {},
  lastError: () => undefined,
  shutdown: async () => {},
});

interface Harness {
  deps: PanelDeps;
  reg: ReturnType<typeof createAgentRegistry>;
  router?: ConversationRouter;
  db: DB;
  cancelled: number[];
  call: (
    method: string,
    path: string,
    body?: unknown,
  ) => Promise<{ handled: boolean; status: number; json: Record<string, unknown> }>;
  cleanup: () => void;
}

// Minimal routing LLM: one classification call replies with a fixed string.
function routingLlm(reply: string) {
  async function* one() {
    yield { delta: reply, done: true, model: 'fake' };
  }
  return { chat: () => one(), resolveModel: () => 'fake' };
}

function harness(llm?: unknown, opts?: { withRouter?: boolean; allowedIds?: number[] }): Harness {
  const home = mkdtempSync(join(tmpdir(), 'modulus-agentroutes-'));
  const db: DB = open({ path: join(home, 'modulus.db'), log });
  const reg = createAgentRegistry(db);
  // Records the task ids the routes ask the runtime to cancel. cancelTask owns
  // both the row flip and the in-flight-turn abort, so the routes must call it
  // (not just write the DB) for Stop to actually halt the model.
  const cancelled: number[] = [];
  // Channel-binding tests opt in to a real ConversationRouter (a fake
  // orchestrator factory — the routes only touch the binding state, never run a
  // turn). Exposed on the harness so a test can assert the router's view.
  const router = opts?.withRouter
    ? createConversationRouter({
        db,
        registry: reg,
        log,
        defaultOrchestrator: fakeOrchestrator(),
        orchestratorFactory: () => fakeOrchestrator(),
      })
    : undefined;
  const deps = {
    db,
    log,
    home,
    // Bindings routes read config for the owner chat; ownerChat → null unless a
    // test supplies an allowlist.
    config: { telegram: { allowedIds: opts?.allowedIds ?? [] } },
    agentRegistry: reg,
    conversationRouter: router,
    agentQueue: { notify() {} },
    agentRuntime: {
      cancelTask(id: number) {
        cancelled.push(id);
        reg.updateTask(id, { status: 'cancelled', finishedAt: Date.now() });
        return true;
      },
    },
    llm: llm ?? {},
  } as unknown as PanelDeps;
  const route = createAgentRoutes(deps);

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
    return {
      handled,
      status,
      json: payload ? (JSON.parse(payload) as Record<string, unknown>) : {},
    };
  }

  return {
    deps,
    reg,
    router,
    db,
    cancelled,
    call,
    cleanup: () => {
      db.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test('GET /api/agents/templates returns the catalog with hire + module hints', async () => {
  const h = harness();
  try {
    const r = await h.call('GET', '/api/agents/templates');
    assert.equal(r.status, 200);
    const templates = r.json['templates'] as Array<Record<string, unknown>>;
    assert.ok(templates.length >= 6);
    const researcher = templates.find((t) => t['id'] === 'researcher')!;
    assert.equal(researcher['alreadyHired'], false);
    // No modules enabled in a fresh DB → the recommended one is flagged missing.
    assert.deepEqual(researcher['missingModules'], ['modulus-websearch']);
    assert.equal(researcher['installedRecommended'], false);
    // A no-module template (writer) reports recommended-installed with nothing missing.
    const writer = templates.find((t) => t['id'] === 'writer')!;
    assert.deepEqual(writer['missingModules'], []);
    assert.equal(writer['installedRecommended'], true);
  } finally {
    h.cleanup();
  }
});

test('POST /api/agents/templates/hire creates a user-owned agent', async () => {
  const h = harness();
  try {
    const r = await h.call('POST', '/api/agents/templates/hire', { id: 'researcher' });
    assert.equal(r.status, 200);
    const agent = r.json['agent'] as Record<string, unknown>;
    assert.equal(agent['name'], 'researcher');
    assert.equal(agent['origin'], null); // user-owned, editable/firable
    assert.equal(agent['profile'], 'tools');
    assert.equal(h.reg.getByName('researcher')!.systemPrompt.length > 0, true);

    // It now shows as already hired in the catalog.
    const cat = await h.call('GET', '/api/agents/templates');
    const researcher = (cat.json['templates'] as Array<Record<string, unknown>>).find(
      (t) => t['id'] === 'researcher',
    )!;
    assert.equal(researcher['alreadyHired'], true);
  } finally {
    h.cleanup();
  }
});

test('POST /api/agents/dispatch-auto routes, enqueues, and returns the chosen agent', async () => {
  const h = harness(routingLlm('NONE'));
  try {
    h.reg.create({
      name: 'researcher',
      role: 'Looks things up and reports the facts',
      systemPrompt: 'x',
      profile: 'tools',
    });
    h.reg.create({ name: 'writer', role: 'Drafts prose', systemPrompt: 'x' });

    const r = await h.call('POST', '/api/agents/dispatch-auto', {
      prompt: 'research the best mini-PCs for a home server',
    });
    assert.equal(r.status, 200);
    const agent = r.json['agent'] as Record<string, unknown>;
    assert.equal(agent['name'], 'researcher'); // rule match, no model call needed
    assert.equal(r.json['via'], 'rule');
    assert.equal(h.reg.listTasks({})[0]!.prompt, 'research the best mini-PCs for a home server');

    // Empty prompt → 400.
    assert.equal((await h.call('POST', '/api/agents/dispatch-auto', { prompt: '' })).status, 400);
  } finally {
    h.cleanup();
  }
});

test('POST /api/agents/dispatch-auto returns agent:null and enqueues nothing on no fit', async () => {
  const h = harness(routingLlm('NONE'));
  try {
    // A tie that escalates to the model, which answers NONE.
    h.reg.create({ name: 'scout', role: 'researches topics', systemPrompt: 'x' });
    h.reg.create({ name: 'digger', role: 'researches facts', systemPrompt: 'x' });
    const r = await h.call('POST', '/api/agents/dispatch-auto', {
      prompt: 'research something undecidable',
    });
    assert.equal(r.status, 200);
    assert.equal(r.json['agent'], null);
    assert.equal(h.reg.listTasks({}).length, 0);
  } finally {
    h.cleanup();
  }
});

test('POST /api/agents/tasks/:id/cancel routes a running task through cancelTask', async () => {
  const h = harness();
  try {
    const agent = h.reg.create({ name: 'worker', role: 'does things', systemPrompt: 'x' });
    const task = h.reg.enqueue({ agentId: agent.id, prompt: 'go' });
    h.reg.updateTask(task.id, { status: 'running' });

    const r = await h.call('POST', `/api/agents/tasks/${task.id}/cancel`);
    assert.equal(r.status, 200);
    // The route must abort the live turn, not just flip the row.
    assert.deepEqual(h.cancelled, [task.id]);
    assert.equal(h.reg.getTask(task.id)!.status, 'cancelled');

    // A second cancel on a now-terminal task is a 409 and does not re-abort.
    const again = await h.call('POST', `/api/agents/tasks/${task.id}/cancel`);
    assert.equal(again.status, 409);
    assert.deepEqual(h.cancelled, [task.id]);
  } finally {
    h.cleanup();
  }
});

test('POST /api/agents/tasks/cancel_all aborts live turns and marks paused rows terminal', async () => {
  const h = harness();
  try {
    const agent = h.reg.create({ name: 'worker', role: 'does things', systemPrompt: 'x' });
    const running = h.reg.enqueue({ agentId: agent.id, prompt: 'a' });
    h.reg.updateTask(running.id, { status: 'running' });
    const queued = h.reg.enqueue({ agentId: agent.id, prompt: 'b' });
    const paused = h.reg.enqueue({ agentId: agent.id, prompt: 'c' });
    h.reg.updateTask(paused.id, { status: 'paused' });

    const r = await h.call('POST', '/api/agents/tasks/cancel_all');
    assert.equal(r.status, 200);
    assert.equal(r.json['count'], 3);
    // Running + queued go through cancelTask (which aborts any in-flight turn);
    // the paused row is flipped directly because cancelTask refuses paused.
    assert.deepEqual(
      h.cancelled.sort((x, y) => x - y),
      [running.id, queued.id].sort((x, y) => x - y),
    );
    assert.equal(h.reg.getTask(paused.id)!.status, 'cancelled');
    assert.equal(h.reg.getTask(running.id)!.status, 'cancelled');
  } finally {
    h.cleanup();
  }
});

test('POST hire: name override, collision 409, unknown 404, bad name 400', async () => {
  const h = harness();
  try {
    // Override name works.
    const named = await h.call('POST', '/api/agents/templates/hire', {
      id: 'researcher',
      name: 'newsbot',
    });
    assert.equal(named.status, 200);
    assert.equal((named.json['agent'] as Record<string, unknown>)['name'], 'newsbot');

    // Default-name hire still works (distinct name).
    assert.equal(
      (await h.call('POST', '/api/agents/templates/hire', { id: 'researcher' })).status,
      200,
    );
    // Hiring the same default name again collides.
    const dup = await h.call('POST', '/api/agents/templates/hire', { id: 'researcher' });
    assert.equal(dup.status, 409);

    // Unknown template id.
    assert.equal((await h.call('POST', '/api/agents/templates/hire', { id: 'ghost' })).status, 404);

    // Bad override name (spaces).
    const bad = await h.call('POST', '/api/agents/templates/hire', {
      id: 'researcher',
      name: 'My Bot',
    });
    assert.equal(bad.status, 400);
  } finally {
    h.cleanup();
  }
});

// ---- Channel bindings ------------------------------------------------------

test('GET /api/agents/bindings returns bindings and the owner chat id', async () => {
  const h = harness(undefined, { withRouter: true, allowedIds: [555] });
  try {
    const r = await h.call('GET', '/api/agents/bindings');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json['bindings'], []);
    assert.equal(r.json['ownerChatId'], 555);
  } finally {
    h.cleanup();
  }
});

test('POST /api/agents/bindings binds a chat to an agent', async () => {
  const h = harness(undefined, { withRouter: true, allowedIds: [555] });
  try {
    const a = h.reg.create({ name: 'coder', systemPrompt: 'x' });
    const r = await h.call('POST', '/api/agents/bindings', { chatId: 42, agentName: 'coder' });
    assert.equal(r.status, 200);
    const binding = r.json['binding'] as Record<string, unknown>;
    assert.equal(binding['agentId'], a.id);
    assert.equal(binding['agentName'], 'coder');
    assert.equal(h.router!.boundAgentId(42), a.id);
  } finally {
    h.cleanup();
  }
});

test('POST /api/agents/bindings without chatId binds the owner chat', async () => {
  const h = harness(undefined, { withRouter: true, allowedIds: [777] });
  try {
    const a = h.reg.create({ name: 'coder', systemPrompt: 'x' });
    const r = await h.call('POST', '/api/agents/bindings', { agentName: 'coder' });
    assert.equal(r.status, 200);
    assert.equal(h.router!.boundAgentId(777), a.id);
  } finally {
    h.cleanup();
  }
});

test('POST /api/agents/bindings to an unknown agent is a 404', async () => {
  const h = harness(undefined, { withRouter: true, allowedIds: [555] });
  try {
    const r = await h.call('POST', '/api/agents/bindings', { chatId: 42, agentName: 'ghost' });
    assert.equal(r.status, 404);
    assert.equal(h.router!.boundAgentId(42), null);
  } finally {
    h.cleanup();
  }
});

test('DELETE /api/agents/bindings/:chatId unbinds the chat', async () => {
  const h = harness(undefined, { withRouter: true, allowedIds: [555] });
  try {
    const a = h.reg.create({ name: 'coder', systemPrompt: 'x' });
    h.router!.bind(42, a.id, 'user');
    const r = await h.call('DELETE', '/api/agents/bindings/42');
    assert.equal(r.status, 200);
    assert.equal(r.json['ok'], true);
    assert.equal(h.router!.boundAgentId(42), null);
  } finally {
    h.cleanup();
  }
});

test('binding routes report unavailable when no router is wired', async () => {
  const h = harness(undefined, { allowedIds: [555] });
  try {
    const r = await h.call('POST', '/api/agents/bindings', { chatId: 42, agentName: 'x' });
    assert.equal(r.status, 503);
  } finally {
    h.cleanup();
  }
});
