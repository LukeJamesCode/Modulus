import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createLogger } from '../util/log.js';
import { createChatDispatcher, type ChatDispatcherDeps } from './chat-dispatch.js';
import type {
  AfterTurnContext,
  ExtensionAfterReplyRecord,
  ExtensionAfterTurnRecord,
  ExtensionCommandRecord,
  ExtensionInterceptRecord,
  HostOrchestrator,
  HostReplyChunk,
} from './extensions.js';

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
  const intercept: ExtensionInterceptRecord = {
    extension: 'instant',
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
  const intercept: ExtensionInterceptRecord = {
    extension: 'ack',
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

test('a /command routes to the matching extension command, not the orchestrator', async () => {
  const { orchestrator, calls } = orchestratorEmitting('should not run');
  const replies: string[] = [];
  let receivedArgs = '';
  const cmd: ExtensionCommandRecord = {
    extension: 'tasks',
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
  const cmd: ExtensionCommandRecord = {
    extension: 'x',
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
  assert.equal(extCmdRan, false, 'core command must not be dispatched to an extension');
  assert.deepEqual(calls, []);
  assert.deepEqual(replies, []);
});

test('afterReply and afterTurn hooks fire after a completed orchestrator turn', async () => {
  const { orchestrator } = orchestratorEmitting('final', { conversationId: 7 });
  const afterReplyText: string[] = [];
  const afterTurnSeen: AfterTurnContext[] = [];
  const afterReply: ExtensionAfterReplyRecord = {
    extension: 'voice',
    handler: async (ctx) => void afterReplyText.push(ctx.text),
  };
  const afterTurn: ExtensionAfterTurnRecord = {
    extension: 'routines',
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
