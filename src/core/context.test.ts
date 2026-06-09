import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { build, approxTokens } from './context.js';

test('build() produces deterministic prefix order: system -> tools -> memory -> session', () => {
  const out = build({
    systemPrompt: 'SYS',
    toolPrompt: 'TOOLS',
    memory: 'MEM',
    session: 'SESS',
    history: [{ role: 'user', content: 'hi' }],
    budgetTokens: 1000,
  });
  assert.equal(out.messages[0]!.role, 'system');
  const sys = out.messages[0]!.content;
  const idxSys = sys.indexOf('SYS');
  const idxTools = sys.indexOf('TOOLS');
  const idxMem = sys.indexOf('MEM');
  const idxSess = sys.indexOf('SESS');
  assert.ok(idxSys < idxTools);
  assert.ok(idxTools < idxMem);
  assert.ok(idxMem < idxSess);
});

test('build() drops oldest history when over budget but keeps the latest user turn', () => {
  const big = 'x'.repeat(400); // ~100 tokens
  const out = build({
    systemPrompt: 'sys',
    history: [
      { role: 'user', content: big },
      { role: 'assistant', content: big },
      { role: 'user', content: big },
      { role: 'assistant', content: big },
      { role: 'user', content: 'latest' },
    ],
    budgetTokens: 200,
  });
  assert.equal(out.truncated, true);
  // The latest user message must survive.
  const last = out.messages[out.messages.length - 1]!;
  assert.equal(last.role, 'user');
  assert.equal(last.content, 'latest');
});

test('build() handles empty history', () => {
  const out = build({ systemPrompt: 'sys', history: [], budgetTokens: 100 });
  assert.equal(out.messages.length, 1);
  assert.equal(out.messages[0]!.role, 'system');
});

test('approxTokens() rough sanity', () => {
  assert.equal(approxTokens(''), 0);
  assert.equal(approxTokens('1234'), 1);
  assert.equal(approxTokens('12345'), 2);
});
