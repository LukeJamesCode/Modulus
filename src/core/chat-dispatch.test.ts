import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createLogger } from '../util/log.js';
import { createChatDispatcher, type ChatDispatcherDeps } from './chat-dispatch.js';
import type { InstantResponder, InstantResponse } from './instant-responses.js';
import type {
  AfterTurnContext,
  ModuleAfterReplyRecord,
  ModuleAfterTurnRecord,
  ModuleCommandRecord,
  ModuleInterceptRecord,
  HostOrchestrator,
  HostReplyChunk,
} from './modules.js';

const log = createLogger({ level: 'error', out: () => {}, err: () => {} });

// A no-op orchestrator that emits a fixed reply (optionally with an afterTurn
// payload) so we can observe the dispatch pipeline without the real model.
function orchestratorEmitting(
  replyText: string,
  afterTurn?: Partial<AfterTurnContext>,
): { orchestrator: HostOrchestrator; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    orchestrator: {
      handleUserMessage: async (msg) => {
        calls.push(msg.text);
        const chunk: HostReplyChunk = {
          delta: replyText,
          done: false,
        };
        await msg.send(chunk);
        await msg.send({
          delta: '',
          done: true,
          ...(afterTurn
            ? {
                meta: {
                  model: 'test-model',
                  elapsedMs: 1,
                  afterTurn: {
                    chatId: 0,
                    userId: 0,
                    conversationId: 0,
                    userText: msg.text,
                    assistantText: '',
                    startedAt: 0,
                    finishedAt: 0,
                    toolCalls: [],
                    ...afterTurn,
                  },
                },
              }
            : {}),
        });
      },
    },
  };
}

function deps(over: Partial<ChatDispatcherDeps>): ChatDispatcherDeps {
  return {
    orchestrator: orchestratorEmitting('hi there').orchestrator,
    commands: () => [],
    intercepts: () => [],
    afterReplies: () => [],
    afterTurns: () => [],
    log,
    ...over,
  };
}

// Settle the detached orchestrator turn (dispatchOrchestratorTurn is `void`ed).
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

test('plain message reaches the orchestrator and replies', async () => {
  const { orchestrator, calls } = orchestratorEmitting('hi there');
  const replies: string[] = [];
  const d = createChatDispatcher(deps({ orchestrator }));
  await d.dispatchInbound({
    chatId: 1,
    userId: 2,
    text: 'hello',
    reply: async (t) => void replies.push(t),
  });
  await flush();
  assert.deepEqual(calls, ['hello']);
  assert.deepEqual(replies, ['hi there']);
});

test('an intercept that does not call next() short-circuits the orchestrator', async () => {
  const { orchestrator, calls } = orchestratorEmitting('model answer');
  const replies: string[] = [];
  const intercept: ModuleInterceptRecord = {
    module: 'instant',
    handler: async (ctx) => {
      // Handle "hi" itself; never call ctx.next() so the model is not invoked.
      if (ctx.text === 'hi') await ctx.reply('hey!');
      else await ctx.next();
    },
  };
  const d = createChatDispatcher(deps({ orchestrator, intercepts: () => [intercept] }));
  await d.dispatchInbound({
    chatId: 1,
    userId: 2,
    text: 'hi',
    reply: async (t) => void replies.push(t),
  });
  await flush();
  assert.deepEqual(calls, [], 'orchestrator must not run when intercept handles the message');
  assert.deepEqual(replies, ['hey!']);
});

test('an intercept calling next() falls through to the orchestrator', async () => {
  const { orchestrator, calls } = orchestratorEmitting('real answer');
  const replies: string[] = [];
  const intercept: ModuleInterceptRecord = {
    module: 'ack',
    handler: async (ctx) => {
      await ctx.reply('checking…');
      await ctx.next();
    },
  };
  const d = createChatDispatcher(deps({ orchestrator, intercepts: () => [intercept] }));
  await d.dispatchInbound({
    chatId: 1,
    userId: 2,
    text: 'what is 2+2',
    reply: async (t) => void replies.push(t),
  });
  await flush();
  assert.deepEqual(calls, ['what is 2+2']);
  assert.deepEqual(replies, ['checking…', 'real answer']);
});

// A canned instant-responder so these tests pin the dispatch wiring (reply is
// terminal, ack continues) rather than the regex classification, which
// instant-responses.test.ts covers.
function fixedResponder(out: InstantResponse | null): InstantResponder {
  return { respond: () => out };
}

test('an instant reply is terminal — sent, and the orchestrator never runs', async () => {
  const { orchestrator, calls } = orchestratorEmitting('model answer');
  const replies: string[] = [];
  const d = createChatDispatcher(
    deps({ orchestrator, instantResponder: fixedResponder({ mode: 'reply', text: 'Morning.' }) }),
  );
  await d.dispatchInbound({
    chatId: 1,
    userId: 2,
    text: 'hi',
    reply: async (t) => void replies.push(t),
  });
  await flush();
  assert.deepEqual(calls, [], 'orchestrator must not run after a terminal instant reply');
  assert.deepEqual(replies, ['Morning.']);
});

test('an instant ack is sent, then the orchestrator still runs and answers', async () => {
  const { orchestrator, calls } = orchestratorEmitting('real answer');
  const replies: string[] = [];
  const d = createChatDispatcher(
    deps({ orchestrator, instantResponder: fixedResponder({ mode: 'ack', text: 'On it.' }) }),
  );
  await d.dispatchInbound({
    chatId: 1,
    userId: 2,
    text: 'add milk to my list',
    reply: async (t) => void replies.push(t),
  });
  await flush();
  assert.deepEqual(calls, ['add milk to my list'], 'orchestrator must run after an ack');
  assert.deepEqual(replies, ['On it.', 'real answer']);
});

test('an instant reply still fires the afterReply chain (so a voice mod speaks it)', async () => {
  const afterReplyText: string[] = [];
  const afterReply: ModuleAfterReplyRecord = {
    module: 'voice',
    handler: async (ctx) => void afterReplyText.push(ctx.text),
  };
  const d = createChatDispatcher(
    deps({
      instantResponder: fixedResponder({ mode: 'reply', text: 'Got it.' }),
      afterReplies: () => [afterReply],
    }),
  );
  await d.dispatchInbound({ chatId: 1, userId: 2, text: 'ok', reply: async () => {} });
  await flush();
  await flush();
  assert.deepEqual(afterReplyText, ['Got it.']);
});

test('a /command routes to the matching module command, not the orchestrator', async () => {
  const { orchestrator, calls } = orchestratorEmitting('should not run');
  const replies: string[] = [];
  let receivedArgs = '';
  const cmd: ModuleCommandRecord = {
    module: 'tasks',
    name: 'tasks',
    description: 'list tasks',
    handler: async (ctx) => {
      receivedArgs = ctx.args;
      await ctx.reply('your tasks: …');
    },
  };
  const d = createChatDispatcher(deps({ orchestrator, commands: () => [cmd] }));
  await d.dispatchInbound({
    chatId: 1,
    userId: 2,
    text: '/tasks today',
    reply: async (t) => void replies.push(t),
  });
  await flush();
  assert.deepEqual(calls, [], 'orchestrator must not run for a command');
  assert.equal(receivedArgs, 'today');
  assert.deepEqual(replies, ['your tasks: …']);
});

test('isCoreCommand leaves core commands for the surface to handle', async () => {
  const { orchestrator, calls } = orchestratorEmitting('x');
  const replies: string[] = [];
  let extCmdRan = false;
  const cmd: ModuleCommandRecord = {
    module: 'x',
    name: 'help',
    description: '',
    handler: async () => {
      extCmdRan = true;
    },
  };
  const d = createChatDispatcher(
    deps({ orchestrator, commands: () => [cmd], isCoreCommand: (h) => h === 'help' }),
  );
  await d.dispatchInbound({
    chatId: 1,
    userId: 2,
    text: '/help',
    reply: async (t) => void replies.push(t),
  });
  await flush();
  assert.equal(extCmdRan, false, 'core command must not be dispatched to a module');
  assert.deepEqual(calls, []);
  assert.deepEqual(replies, []);
});

test('the memory extractor runs detached, after the reply has shipped', async () => {
  const { orchestrator } = orchestratorEmitting('final', { userText: 'remember milk' });
  const replies: string[] = [];
  const seen: AfterTurnContext[] = [];
  let replyShippedFirst = false;
  const memoryExtractor = async (turn: AfterTurnContext): Promise<void> => {
    // Observed at call time: the reply must already be out (it's awaited before
    // the detached afterTurn block runs), proving extraction never blocks it.
    replyShippedFirst = replies.length > 0;
    seen.push(turn);
  };
  const d = createChatDispatcher(deps({ orchestrator, memoryExtractor }));
  await d.dispatchInbound({
    chatId: 1,
    userId: 2,
    text: 'remember milk',
    reply: async (t) => void replies.push(t),
  });
  await flush();
  await flush();
  assert.deepEqual(replies, ['final']);
  assert.equal(seen.length, 1, 'extractor must be invoked with the turn');
  assert.equal(seen[0]!.assistantText, 'final');
  assert.ok(replyShippedFirst, 'the reply must be sent before the extractor runs');
});

test('a throwing memory extractor is isolated and never breaks the turn', async () => {
  const { orchestrator } = orchestratorEmitting('final', { userText: 'remember milk' });
  const replies: string[] = [];
  const memoryExtractor = async (): Promise<void> => {
    throw new Error('extractor blew up');
  };
  const d = createChatDispatcher(deps({ orchestrator, memoryExtractor }));
  await assert.doesNotReject(() =>
    d.dispatchInbound({
      chatId: 1,
      userId: 2,
      text: 'remember milk',
      reply: async (t) => void replies.push(t),
    }),
  );
  await flush();
  await flush();
  assert.deepEqual(replies, ['final'], 'the reply still ships despite the extractor throwing');
});

test('afterReply and afterTurn hooks fire after a completed orchestrator turn', async () => {
  const { orchestrator } = orchestratorEmitting('final', { conversationId: 7 });
  const afterReplyText: string[] = [];
  const afterTurnSeen: AfterTurnContext[] = [];
  const afterReply: ModuleAfterReplyRecord = {
    module: 'voice',
    handler: async (ctx) => void afterReplyText.push(ctx.text),
  };
  const afterTurn: ModuleAfterTurnRecord = {
    module: 'routines',
    handler: async (turn) => void afterTurnSeen.push(turn),
  };
  const d = createChatDispatcher(
    deps({ orchestrator, afterReplies: () => [afterReply], afterTurns: () => [afterTurn] }),
  );
  await d.dispatchInbound({ chatId: 1, userId: 2, text: 'remember milk', reply: async () => {} });
  await flush();
  await flush();
  assert.deepEqual(afterReplyText, ['final']);
  assert.equal(afterTurnSeen.length, 1);
  assert.equal(afterTurnSeen[0]!.assistantText, 'final');
  assert.equal(afterTurnSeen[0]!.conversationId, 7);
});

test('resolveOrchestrator routes a bound chat to its agent orchestrator', async () => {
  const def = orchestratorEmitting('default agent');
  const agent = orchestratorEmitting('bound agent');
  // chat 99 is "bound" to the agent orchestrator; every other chat uses default.
  const resolveOrchestrator = (chatId: number): HostOrchestrator =>
    chatId === 99 ? agent.orchestrator : def.orchestrator;

  const d = createChatDispatcher(deps({ orchestrator: def.orchestrator, resolveOrchestrator }));

  const boundReplies: string[] = [];
  await d.dispatchInbound({
    chatId: 99,
    userId: 2,
    text: 'who are you',
    reply: async (t) => void boundReplies.push(t),
  });
  await flush();
  assert.deepEqual(agent.calls, ['who are you'], 'bound chat hits the agent orchestrator');
  assert.deepEqual(def.calls, [], 'and not the default');
  assert.deepEqual(boundReplies, ['bound agent']);

  const otherReplies: string[] = [];
  await d.dispatchInbound({
    chatId: 1,
    userId: 2,
    text: 'hello',
    reply: async (t) => void otherReplies.push(t),
  });
  await flush();
  assert.deepEqual(def.calls, ['hello'], 'unbound chat uses the default orchestrator');
  assert.deepEqual(otherReplies, ['default agent']);
});

test('without resolveOrchestrator every chat uses the default orchestrator', async () => {
  const { orchestrator, calls } = orchestratorEmitting('default');
  const d = createChatDispatcher(deps({ orchestrator }));
  await d.dispatchInbound({ chatId: 5, userId: 2, text: 'hi', reply: async () => {} });
  await flush();
  assert.deepEqual(calls, ['hi']);
});

test('the surface source label is forwarded to the orchestrator turn', async () => {
  const sources: Array<string | undefined> = [];
  const orchestrator: HostOrchestrator = {
    handleUserMessage: async (msg) => {
      sources.push(msg.source);
      await msg.send({ delta: 'ok', done: true });
    },
  };
  // Dispatcher-level source tags every turn (Telegram wires source: 'telegram').
  const d = createChatDispatcher(deps({ orchestrator, source: 'telegram' }));
  await d.dispatchInbound({ chatId: 5, userId: 2, text: 'hi', reply: async () => {} });
  // A per-message source overrides the dispatcher default (shared module router).
  await d.dispatchInbound({
    chatId: 6,
    userId: 2,
    text: 'yo',
    source: 'discord',
    reply: async () => {},
  });
  await flush();
  assert.deepEqual(sources, ['telegram', 'discord']);
});
