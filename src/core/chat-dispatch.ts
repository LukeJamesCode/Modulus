// Surface-neutral inbound message pipeline, shared by every chat surface
// (the Telegram adapter, modulus-discord, and any future Matrix/Slack surface).
//
// Extracted from the Telegram adapter so that commands, message intercepts, the
// orchestrator turn, and the afterReply/afterTurn hooks all run identically no
// matter which surface a message arrives on. The whole pipeline was already
// surface-neutral — every handler context carries plain primitives (chatId,
// userId, args, text, reply) and never touches grammY — so the only things a
// surface injects are: how a reply is rendered/length-capped (`reply`), whether
// a leading `/word` is a core command it handles itself (`isCoreCommand`), and
// whether to annotate replies with devmode metadata (`getDevmode`).
//
// Two instances exist at runtime: the Telegram adapter builds one with its core
// commands + devmode wired in; the module loader builds a plain one and hands
// it to chat-surface modules via host.chat.dispatchInbound.

import type { Logger } from '../util/log.js';
import type { InstantResponder } from './instant-responses.js';
import type {
  HostOrchestrator,
  HostReplyChunk,
  ModuleCommandRecord,
  ModuleInterceptRecord,
  ModuleAfterReplyRecord,
  ModuleAfterTurnRecord,
  TelegramCommandContext,
  TelegramInterceptContext,
  AfterTurnContext,
} from './modules.js';

export interface InboundMessage {
  chatId: number;
  userId: number;
  text: string;
  // Send a reply on the originating surface. The surface owns length-capping
  // (Telegram 4096 / Discord 2000) and any markdown quirks. Called with the full
  // assembled text; may be called more than once per turn (e.g. an intercept ack
  // followed by the orchestrator's answer).
  reply: (text: string) => Promise<void>;
}

export interface ChatDispatcherDeps {
  orchestrator: HostOrchestrator;
  // Live registry accessors — called per message so hot-reload is visible.
  commands: () => ModuleCommandRecord[];
  intercepts: () => ModuleInterceptRecord[];
  afterReplies: () => ModuleAfterReplyRecord[];
  afterTurns: () => ModuleAfterTurnRecord[];
  log: Logger;
  // Returns true if `head` (the word after the leading '/') names a core command
  // the surface already handles itself; the dispatcher then leaves it alone.
  // Telegram passes CORE_COMMANDS.has; surfaces without core commands omit it.
  isCoreCommand?: (head: string) => boolean;
  // Per-chat devmode flag. When true the orchestrator reply is annotated with
  // model/timing/tool metadata. Telegram only; omit elsewhere.
  getDevmode?: (chatId: number) => boolean;
  // Core instant responses (gated by `instantResponses.enabled`). When present,
  // free-form messages get a templated reply or a pre-answer ack before the
  // module intercept chain runs. Omit to disable.
  instantResponder?: InstantResponder;
}

export interface ChatDispatcher {
  dispatchInbound(msg: InboundMessage): Promise<void>;
}

export function createChatDispatcher(deps: ChatDispatcherDeps): ChatDispatcher {
  const { orchestrator, log } = deps;

  const runAfterReplies = async (chatId: number, userId: number, reply: string): Promise<void> => {
    if (!reply || reply === '(no reply)') return;
    for (const h of deps.afterReplies()) {
      try {
        await h.handler({
          chatId,
          userId,
          text: reply,
          log: log.child({ mod: h.module, hook: 'afterReply' }),
        });
      } catch (e) {
        log.warn('afterReply hook failed', { mod: h.module, error: errStr(e) });
      }
    }
  };

  const runAfterTurns = async (turn: AfterTurnContext): Promise<void> => {
    if (!turn.assistantText || turn.assistantText === '(no reply)') return;
    for (const h of deps.afterTurns()) {
      try {
        await h.handler(turn);
      } catch (e) {
        log.warn('afterTurn hook failed', { mod: h.module, error: errStr(e) });
      }
    }
  };

  const invokeModuleCommand = async (
    name: string,
    args: string,
    chatId: number,
    userId: number,
    reply: (text: string) => Promise<void>,
  ): Promise<boolean> => {
    const moduleCmd = deps.commands().find((c) => c.name === name);
    if (!moduleCmd) return false;
    const cctx: TelegramCommandContext = {
      chatId,
      userId,
      args,
      reply: async (t) => {
        await reply(t);
      },
    };
    try {
      await moduleCmd.handler(cctx);
    } catch (e) {
      log.warn('module command failed', {
        mod: moduleCmd.module,
        command: name,
        error: errStr(e),
      });
      await reply(`Command failed: ${errStr(e)}`);
    }
    return true;
  };

  // Fire-and-forget orchestrator turn: buffers streamed deltas and ships the
  // assembled reply on `done`, then runs the afterReply/afterTurn chains. Detached
  // (`void`) so the surface's update loop isn't blocked waiting on the model.
  const dispatchOrchestratorTurn = (
    chatId: number,
    userId: number,
    text: string,
    reply: (text: string) => Promise<void>,
  ): void => {
    let buffer = '';
    const devmode = deps.getDevmode?.(chatId) ?? false;
    void orchestrator
      .handleUserMessage({
        chatId,
        userId,
        text,
        send: async (chunk: HostReplyChunk) => {
          if (chunk.delta) buffer += chunk.delta;
          if (!chunk.done) return;
          // Hallucination guard (see orchestrator): the orchestrator can replace
          // the streamed buffer wholesale when the model claimed an action that
          // never ran.
          if (chunk.replace !== undefined) buffer = chunk.replace;
          const replyText = buffer.length > 0 ? buffer : '(no reply)';
          let display = replyText;
          if (devmode && chunk.meta) {
            display += `\n\n— ${chunk.meta.model}, ${chunk.meta.elapsedMs}ms`;
            if (chunk.meta.promptTokens !== undefined) {
              display += `, ${chunk.meta.promptTokens} prompt`;
            }
            if (chunk.meta.completionTokens !== undefined) {
              display += `, ${chunk.meta.completionTokens} completion`;
            }
            const toolCalls = chunk.meta.afterTurn?.toolCalls ?? [];
            display +=
              toolCalls.length > 0
                ? `\ntools: ${toolCalls.map((c) => `${c.name}${c.ok ? '' : '✗'}`).join(', ')}`
                : `\ntools: none`;
          }
          try {
            await reply(display);
          } catch (e) {
            log.warn('reply failed', { error: errStr(e) });
          }
          void runAfterReplies(chatId, userId, replyText).catch((e) =>
            log.warn('afterReply chain failed', { error: errStr(e) }),
          );
          if (chunk.meta?.afterTurn) {
            void runAfterTurns({
              ...chunk.meta.afterTurn,
              assistantText: replyText,
              finishedAt: Date.now(),
            }).catch((e) => log.warn('afterTurn chain failed', { error: errStr(e) }));
          }
        },
      })
      .catch((e) => log.warn('orchestrator message failed', { error: errStr(e) }));
  };

  async function dispatchInbound(msg: InboundMessage): Promise<void> {
    const { chatId, userId, text, reply } = msg;

    if (text.startsWith('/')) {
      const space = text.indexOf(' ');
      // Strip a trailing @botname (Telegram renders `/cmd@Bot` in groups).
      const head = (space === -1 ? text.slice(1) : text.slice(1, space)).split('@')[0]!;
      if (deps.isCoreCommand?.(head)) return; // surface handles its own core commands
      const args = space === -1 ? '' : text.slice(space + 1).trim();
      await invokeModuleCommand(head, args, chatId, userId, reply);
      // Unknown command falls through silently — matches Telegram behaviour.
      return;
    }

    // Core instant responses, before any module intercept. A 'reply' is
    // terminal (templated chatter / a computed answer — the model never runs);
    // an 'ack' is sent now and the turn continues to the orchestrator. Both
    // fire the afterReply chain so a voice module speaks them, matching how
    // an intercept's reply behaved when this lived in gurney-instant-responses.
    const instant = deps.instantResponder?.respond(text, chatId);
    if (instant) {
      await reply(instant.text);
      void runAfterReplies(chatId, userId, instant.text).catch((e) =>
        log.warn('afterReply chain failed (instant)', { error: errStr(e) }),
      );
      if (instant.mode === 'reply') return;
    }

    // Intercept chain. Each intercept can call next() to fall through to the
    // orchestrator; one that fully handles the message simply never calls next().
    // Run in registration order.
    const intercepts = deps.intercepts();
    let handed = false;
    const runOrchestrator = async (): Promise<void> => {
      if (handed) return;
      handed = true;
      dispatchOrchestratorTurn(chatId, userId, text, reply);
    };
    let i = 0;
    const runNext = async (): Promise<void> => {
      const item = intercepts[i++];
      if (!item) {
        await runOrchestrator();
        return;
      }
      const ictx: TelegramInterceptContext = {
        chatId,
        userId,
        text,
        args: text,
        // reply() sends a message but does NOT mark the turn handled — flow
        // control belongs to next(). An intercept wanting to fully handle the
        // message just doesn't call next(); one that wants a quick ack then the
        // real answer (modulus-instant-responses) replies and then calls next().
        reply: async (t) => {
          await reply(t);
          void runAfterReplies(chatId, userId, t).catch((e) =>
            log.warn('afterReply chain failed (intercept)', { error: errStr(e) }),
          );
        },
        next: runNext,
      };
      try {
        await item.handler(ictx);
      } catch (e) {
        log.warn('intercept failed', { mod: item.module, error: errStr(e) });
      }
    };
    await runNext();
  }

  return { dispatchInbound };
}

function errStr(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
