import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '../../util/log.js';
import type { ChatChunk, ChatOptions } from '../../core/llm.js';
import type { PanelDeps } from '../types.js';
import { buildImproveMessages, clean, createImproveRoutes } from './improve.js';

const log = createLogger({ level: 'error', out: () => {}, err: () => {} });

// A tiny FakeLLM: yields `reply` as one delta, recording the options it saw so a
// test can assert profile/maxTokens/thinkMode. `fail` makes chat() throw, to
// exercise the 502 path.
function fakeLLM(opts: { reply?: string; fail?: boolean } = {}) {
  const seen: ChatOptions[] = [];
  return {
    seen,
    llm: {
      async *chat(o: ChatOptions): AsyncIterable<ChatChunk> {
        seen.push(o);
        if (opts.fail) throw new Error('boom');
        yield { delta: opts.reply ?? '', done: true };
      },
    },
  };
}

function harness(llm: unknown) {
  const deps = { log, llm } as unknown as PanelDeps;
  const route = createImproveRoutes(deps);
  return async (method: string, path: string, body?: unknown) => {
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
    return { handled, status, json: payload ? (JSON.parse(payload) as Record<string, unknown>) : {} };
  };
}

test('improve: rewrites the draft and returns the model text', async () => {
  const f = fakeLLM({ reply: 'Summarize my unread email and draft three replies.' });
  const call = harness(f.llm);
  const r = await call('POST', '/api/improve-prompt', { text: 'do my email', kind: 'agent-task' });
  assert.equal(r.handled, true);
  assert.equal(r.status, 200);
  assert.equal(r.json['text'], 'Summarize my unread email and draft three replies.');
  // One bounded, non-streaming-style call on the tiny chat profile, no thinking.
  assert.equal(f.seen.length, 1);
  assert.equal(f.seen[0]!.profile, 'chat');
  assert.equal(f.seen[0]!.thinkMode, 'off');
  assert.ok((f.seen[0]!.maxTokens ?? 0) > 0);
  // The draft is the user message; the system message carries the rewrite policy.
  assert.equal(f.seen[0]!.messages.at(-1)?.content, 'do my email');
});

test('improve: empty text is a 400, no model call', async () => {
  const f = fakeLLM({ reply: 'x' });
  const call = harness(f.llm);
  const r = await call('POST', '/api/improve-prompt', { text: '   ' });
  assert.equal(r.status, 400);
  assert.equal(f.seen.length, 0);
});

test('improve: over-long text is rejected before any model call', async () => {
  const f = fakeLLM({ reply: 'x' });
  const call = harness(f.llm);
  const r = await call('POST', '/api/improve-prompt', { text: 'a'.repeat(4001) });
  assert.equal(r.status, 400);
  assert.equal(f.seen.length, 0);
});

test('improve: a model failure surfaces as a friendly 502', async () => {
  const f = fakeLLM({ fail: true });
  const call = harness(f.llm);
  const r = await call('POST', '/api/improve-prompt', { text: 'hello there friend' });
  assert.equal(r.status, 502);
  assert.match(String(r.json['error']), /try again/);
});

test('improve: an all-whitespace rewrite is treated as a failure', async () => {
  const f = fakeLLM({ reply: '   \n  ' });
  const call = harness(f.llm);
  const r = await call('POST', '/api/improve-prompt', { text: 'hello there friend' });
  assert.equal(r.status, 502);
});

test('improve: passes other methods/paths through', async () => {
  const call = harness(fakeLLM().llm);
  const r = await call('GET', '/api/improve-prompt');
  assert.equal(r.handled, false);
});

test('improve: clean() strips a code fence and surrounding quotes', () => {
  assert.equal(clean('```\nhello\n```'), 'hello');
  assert.equal(clean('```md\nhi there\n```'), 'hi there');
  assert.equal(clean('"just quoted"'), 'just quoted');
  assert.equal(clean('“smart quoted”'), 'smart quoted');
  assert.equal(clean('  plain  '), 'plain');
});

test('improve: per-kind guidance changes the system prompt', () => {
  const generic = buildImproveMessages('x', 'nonsense-kind')[0]!.content;
  const routine = buildImproveMessages('x', 'routine')[0]!.content;
  assert.notEqual(generic, routine);
  assert.match(routine, /automation/i);
});
