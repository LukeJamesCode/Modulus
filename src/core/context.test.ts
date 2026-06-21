import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { build, approxTokens } from './context.js';

test('build() prefix is system -> tools -> session; volatile context rides the tail', () => {
  const out = build({
    systemPrompt: 'SYS',
    toolPrompt: 'TOOLS',
    turnContext: 'CLOCK',
    memory: 'MEM',
    session: 'SESS',
    history: [{ role: 'user', content: 'hi' }],
    budgetTokens: 1000,
  });
  // Stable prefix in messages[0] — no clock, no memory (those are volatile).
  assert.equal(out.messages[0]!.role, 'system');
  const sys = out.messages[0]!.content;
  assert.ok(sys.indexOf('SYS') < sys.indexOf('TOOLS'));
  assert.ok(sys.indexOf('TOOLS') < sys.indexOf('SESS'));
  assert.ok(!sys.includes('CLOCK'));
  assert.ok(!sys.includes('MEM'));
  // Volatile tail is its own system message injected right before the user turn.
  const tail = out.messages[out.messages.length - 2]!;
  assert.equal(tail.role, 'system');
  assert.ok(tail.content.indexOf('CLOCK') < tail.content.indexOf('MEM'));
  // The user turn stays last so the model answers it with the freshest context.
  assert.equal(out.messages[out.messages.length - 1]!.role, 'user');
});

test('build() puts the tail before the latest user turn, after prior history', () => {
  const out = build({
    systemPrompt: 'SYS',
    turnContext: 'CLOCK',
    memory: 'MEM',
    history: [
      { role: 'user', content: 'older' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'latest' },
    ],
    budgetTokens: 1000,
  });
  const roles = out.messages.map((m) => m.role);
  const tailIdx = out.messages.findIndex((m) => m.content.includes('CLOCK'));
  // Prior history (older/reply) precedes the tail; the latest user turn follows.
  assert.ok(out.messages[tailIdx - 1]!.content === 'reply');
  assert.equal(out.messages[tailIdx + 1]!.content, 'latest');
  assert.equal(roles[roles.length - 1], 'user');
});

test('build() with no history still emits the tail (appended)', () => {
  const out = build({
    systemPrompt: 'SYS',
    turnContext: 'CLOCK',
    history: [],
    budgetTokens: 1000,
  });
  assert.ok(out.messages.some((m) => m.content.includes('CLOCK')));
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
