// codex_handoff — the escalation tool the local Qwen model calls when a task is
// beyond what it can do at quality. Codex is a GENERAL heavy-lifter: hard
// coding, deep reasoning, detailed writing/planning/analysis — anything
// text-based the small model can't do well. Codex answers AS Modulus (see the
// system instructions in lib/codex.ts) and, because this tool is `selfReplying`,
// that in-voice answer is sent to the user verbatim instead of being re-chewed
// (and degraded) by the 0.8b model.
//
// It runs at the `confirm` tier: every call pops a Yes/No prompt in the chat
// (via core's confirm hook) so Codex quota is never spent without the user's
// say-so. The daily budget ceiling in lib/budget.ts and the prompt fragment
// (prompt.md) bound how often it's reached for.

import type { Host } from '../../src/core/modules.js';
import { runHandoff } from './lib/run.js';
import { readTokens } from './lib/store.js';
import { createCodexModelProvider } from './lib/model-provider.js';

// Deterministic auto-route heuristic. Returns true when a message looks like a
// substantial generative task the local model can't do well — so the
// orchestrator forces the handoff (still behind the Yes/No confirm) instead of
// trusting a 0.8b model to choose. Conservative by design, and a false positive
// only costs the user one tap to decline (after which the local model answers).
//
//   - PRODUCE_VERB: the user wants something created/produced/reasoned.
//   - SUBSTANCE: a signal the output is meant to be sizeable/detailed — OR the
//     request is simply long (>= 18 words).
//   - LOCAL_ACTION: hard exclude — these are the local model's tool-actions and
//     personal-data lookups, which Codex cannot do anyway.
const PRODUCE_VERB =
  /\b(write|draft|compose|create|build|generate|design|implement|refactor|debug|code|script|program|analy[sz]e|summari[sz]e|explain|research|compare|translate|brainstorm|outline|plan)\b/i;
const SUBSTANCE =
  /\b(detailed|step[-\s]?by[-\s]?step|comprehensive|thorough|in[-\s]?depth|full|complete|entire|whole|complex|advanced|robust|production|essay|guide|tutorial|document|report|readme|spec|architecture|algorithm|function|class|module|script|program|plan)\b/i;
const LOCAL_ACTION =
  /\b(remind|reminder|alarm|timer|my calendar|my schedule|schedule my|my day|my week|to-?do|todo|weather|forecast|appointment|my events?)\b/i;

export function shouldAutoRoute(message: string): boolean {
  const m = message.trim();
  if (m.length < 12) return false;
  if (LOCAL_ACTION.test(m)) return false;
  if (!PRODUCE_VERB.test(m)) return false;
  if (SUBSTANCE.test(m)) return true;
  return m.split(/\s+/).length >= 18;
}

// One-line, human-readable summary of `task` for the confirm prompt.
function previewTask(args: Record<string, unknown>): string {
  const task = typeof args['task'] === 'string' ? (args['task'] as string).trim() : '';
  const oneLine = task.replace(/\s+/g, ' ');
  const clipped = oneLine.length > 160 ? oneLine.slice(0, 157) + '…' : oneLine;
  return `Hand this to Codex (deep-reasoning brain)?\n“${clipped || '(no task given)'}”`;
}

const HANDOFF_INTENT =
  '\\b(code|coding|refactor|implement|debug|rewrite|optimi[sz]e|function|script|program|regex|algorithm|tests?|write|draft|essay|email|explain|summari[sz]e|analy[sz]e|plan|design|outline|research|compare|calculate|solve|translate|brainstorm)\\b';

export function register(host: Host): void {
  host.llm.registerProvider?.(createCodexModelProvider(host));

  host.tools.register({
    name: 'codex_handoff',
    intentPattern: HANDOFF_INTENT,
    description:
      'Hand a HARD task to Codex — your own deep-reasoning brain (a powerful remote model) — and return its complete answer to the user. ' +
      'Use when the task needs more capability than you have: complex or multi-file coding, careful debugging, deep step-by-step reasoning, ' +
      'detailed writing or drafting, planning, or thorough analysis. ' +
      'Do NOT use for things you can already answer well, for trivial chat, or for ACTIONS that need your tools ' +
      "(calendar, reminders, weather, etc.) or the user's private data — Codex cannot run tools or see your data. " +
      'Each call asks the user to confirm and spends from a small daily budget, so reserve it for tasks you genuinely cannot do at quality.',
    tier: 'confirm',
    confirmPrompt: previewTask,
    // Deterministic escalation: when the message clearly needs Codex, claim the
    // turn outright rather than hoping the local model calls the tool. Gated on
    // auth so an unconfigured install never force-routes (it just lets the local
    // model answer). The confirm prompt + budget still apply.
    autoRoute: (userMessage) =>
      readTokens(host) !== null && shouldAutoRoute(userMessage) ? { task: userMessage } : null,
    // Codex answers in Modulus's voice; ship it straight to the user instead of
    // having the 0.8b model paraphrase (and degrade) it.
    selfReplying: true,
    // Codex can take a while; give it generous headroom over the default tool
    // timeout. The actual network deadline is enforced inside callCodex via the
    // request_timeout_ms setting. Note the confirm prompt's own wait is
    // separate (CONFIRM_TIMEOUT_MS in the Telegram adapter).
    timeoutMs: 180_000,
    parameters: {
      type: 'object',
      required: ['task'],
      properties: {
        task: {
          type: 'string',
          description:
            'A clear, self-contained description of what you need done or answered. Codex cannot see this chat — restate everything it needs.',
        },
        context: {
          type: 'string',
          description:
            'Optional. Paste any relevant details from the conversation — existing code, error messages, facts, the user’s constraints — so Codex has what it needs.',
        },
        success_criteria: {
          type: 'string',
          description: 'Optional. What a good answer looks like.',
        },
      },
    },
    invoke: async (args, ctx) => {
      const a = args as { task?: string; context?: string; success_criteria?: string };
      const task = a.task?.trim();
      if (!task) {
        return 'codex_handoff needs a `task` describing what you want done. Re-call with a clear, self-contained brief.';
      }

      const input: Parameters<typeof runHandoff>[1] = { task, source: 'tool' };
      if (a.context?.trim()) input.context = a.context.trim();
      if (a.success_criteria?.trim()) input.successCriteria = a.success_criteria.trim();
      if (ctx.chatId !== undefined) input.chatId = ctx.chatId;
      if (ctx.conversationId !== undefined) input.conversationId = ctx.conversationId;
      if (ctx.signal) input.signal = ctx.signal;

      const outcome = await runHandoff(host, input);
      // selfReplying: whatever we return is shown to the user verbatim. On
      // success that's Codex's in-voice answer; on denial/error it's a clean
      // one-line message. Either way, no extra prefix.
      return outcome.ok ? outcome.result.text : outcome.message;
    },
  });
}
