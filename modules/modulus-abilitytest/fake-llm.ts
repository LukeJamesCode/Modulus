// A scriptable LLM for the deterministic ability-test subset. Each chat() call
// consumes the next scripted round, so a test pins exactly what the "model"
// does — emit a tool call, or produce final text — and the run is reproducible
// with no Ollama, no network. This is the seam that lets the harness exercise
// the REAL orchestrator (tool dispatch loop, reply streaming, history) against
// a known model, so a regression in the agent pipeline shows up as a failed
// ability test rather than a flaky live run.

import type { ChatChunk, LLM } from '../../src/core/llm.js';

// One scripted model turn: call a tool, or speak final text. A script must end
// with a `text` round — the orchestrator loops calling the model until it
// produces text (or hits maxToolRounds), so a trailing tool round would ask the
// fake for a round it doesn't have.
export type ModelRound = { tool: string; args?: Record<string, unknown> } | { text: string };

async function* roundStream(round: ModelRound): AsyncIterable<ChatChunk> {
  if ('text' in round) {
    yield { delta: round.text, done: true, model: 'fake', promptTokens: 5, completionTokens: 1 };
    return;
  }
  yield {
    delta: '',
    done: true,
    model: 'fake',
    toolCalls: [{ id: `call_${round.tool}`, name: round.tool, arguments: round.args ?? {} }],
    promptTokens: 5,
    completionTokens: 1,
  };
}

export interface ScriptedLLM extends LLM {
  // How many chat() rounds the orchestrator actually consumed — a cheap way for
  // a test to assert the model was (or wasn't) re-invoked after a tool result.
  roundsConsumed(): number;
}

export function createScriptedLLM(rounds: readonly ModelRound[]): ScriptedLLM {
  let i = 0;
  const llm: LLM = {
    chat() {
      const round = rounds[i++];
      if (!round) {
        throw new Error(
          'ability-test model script exhausted — every script must end with a { text } round',
        );
      }
      return roundStream(round);
    },
    async health() {
      return { ok: true, models: ['fake'] };
    },
    listProfiles() {
      return {
        chat: { model: 'fake', contextTokens: 4096, heavy: false },
        reason: null,
        tools: null,
      };
    },
    resolveModel() {
      return 'fake';
    },
    breakerSnapshot: () => ({
      state: 'closed',
      failures: 0,
      consecutiveSuccesses: 0,
      openedAt: null,
      retryAt: null,
    }),
    stopIdleEviction: () => {},
  };
  return Object.assign(llm, { roundsConsumed: () => i });
}
