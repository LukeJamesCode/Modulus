// Regression: when a turn crashed mid-tool-round, the orchestrator used to
// leave the conversation with an "assistant requested tool X" row but no
// matching "tool X returned …" row. The next load reconstructed an invalid
// history and the model got confused. Writes are now buffered and flushed in
// a transaction at the end of each round, so a mid-round crash drops the
// whole round.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../storage/db.js';
import { createOrchestrator } from './orchestrator.js';
import { createToolRegistry } from './tools.js';
import { createLogger } from '../util/log.js';
import type { ChatChunk, LLM } from './llm.js';
import type { ToolRegistry } from './tools.js';

function silentLogger() {
  return createLogger({ level: 'error', out: () => {}, err: () => {} });
}

async function* toolCallStream(): AsyncIterable<ChatChunk> {
  // Assistant emits some preamble text AND a tool call. The orchestrator
  // would otherwise write the assistant row immediately (pre-fix) and then
  // discover the tool throws on execute.
  yield { delta: 'I will use the tool. ', done: false, model: 'fake' };
  yield {
    delta: '',
    done: true,
    toolCalls: [{ id: 'c1', name: 'boom', arguments: {} }],
    model: 'fake',
  };
}

test('failed tool execution leaves no partial round in the messages table', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'modulus-orch-tx-'));
  try {
    const db = open({ path: join(dir, 'g.db') });
    const log = silentLogger();
    const realTools = createToolRegistry({ log });
    realTools.register({
      name: 'boom',
      description: 'always fails',
      parameters: {},
      tier: 'auto',
      invoke: async () => 'never',
    });
    // Wrap the registry so execute() throws an uncaught error — i.e. the
    // process is effectively killed mid-tool. The real registry catches and
    // turns errors into ToolResult, so we have to bypass it to simulate the
    // SIGTERM / OOM case the S4 fix actually defends against.
    const throwingTools: ToolRegistry = {
      ...realTools,
      execute: async () => {
        throw new Error('simulated mid-round crash');
      },
    };
    const llm: LLM = {
      chat: () => toolCallStream(),
      async health() {
        return { ok: true, models: ['fake'] };
      },
      listProfiles: () => ({
        chat: { model: 'fake', contextTokens: 4096, heavy: false },
        reason: null,
        tools: null,
      }),
      resolveModel: () => 'fake',
      breakerSnapshot: () => ({
        state: 'closed',
        failures: 0,
        consecutiveSuccesses: 0,
        openedAt: null,
        retryAt: null,
      }),
      stopIdleEviction: () => {},
    };
    const orch = createOrchestrator({ db, llm, tools: throwingTools, log });
    await orch.handleUserMessage({
      chatId: 42,
      userId: 1,
      text: 'go',
      send: async () => {},
    });

    const rows = db
      .prepare(
        `SELECT role, tool_call_id, tool_name FROM messages
         WHERE conversation_id = (
           SELECT current_conversation_id FROM telegram_chats WHERE chat_id = 42
         )
         ORDER BY id`,
      )
      .all() as Array<{ role: string; tool_call_id: string | null; tool_name: string | null }>;

    // Atomicity invariant: no row may carry a tool_call_id without a
    // matching tool row. With the S4 fix the round's writes are buffered
    // and never flushed because the crash happens before flushRound() —
    // so only the user message remains.
    const toolCallRows = rows.filter((r) => r.role === 'assistant' && r.tool_call_id);
    const toolRows = rows.filter((r) => r.role === 'tool');
    assert.equal(
      toolCallRows.length,
      toolRows.length,
      'tool-call requests and tool-result rows must come in pairs',
    );
    // And the user message itself is durable.
    assert.ok(
      rows.some((r) => r.role === 'user'),
      'user message must be persisted',
    );
    db.close();
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows can hold WAL handles briefly after close() */
    }
  }
});
