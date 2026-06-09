import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createLogger } from './log.js';
import { redactString, redact } from './redact.js';

test('logger respects level threshold', () => {
  const lines: string[] = [];
  const log = createLogger({
    level: 'warn',
    out: (l) => lines.push(l),
    err: (l) => lines.push(l),
    now: () => new Date('2026-01-01T00:00:00Z'),
  });
  log.debug('skip me');
  log.info('skip me');
  log.warn('keep me', { a: 1 });
  log.error('keep me too');
  assert.equal(lines.length, 2);
  const w = JSON.parse(lines[0]!);
  assert.equal(w.level, 'warn');
  assert.equal(w.msg, 'keep me');
  assert.equal(w.a, 1);
});

test('logger redacts secrets in fields and messages', () => {
  const lines: string[] = [];
  const log = createLogger({ level: 'info', out: (l) => lines.push(l), err: (l) => lines.push(l) });
  log.info('connecting with token=123456:AAH-this-is-a-fake-bot-token-xxxxxxxx', {
    bot_token: 'super-secret-value',
    nested: { authorization: 'Bearer abc123def456' },
  });
  assert.equal(lines.length, 1);
  const r = JSON.parse(lines[0]!);
  assert.match(r.msg, /\[redacted\]/);
  assert.equal(r.bot_token, '[redacted]');
  assert.equal(r.nested.authorization, '[redacted]');
});

test('child logger merges bindings', () => {
  const lines: string[] = [];
  const log = createLogger({ level: 'info', out: (l) => lines.push(l) }).child({ mod: 'tg' });
  log.info('hi');
  const r = JSON.parse(lines[0]!);
  assert.equal(r.mod, 'tg');
});

test('redactString masks Telegram tokens and Bearer headers', () => {
  const out = redactString(
    'token=12345:AAH-fake-bot-token-xxxxxxxxxxxxxxxxxxxxxx Bearer abcdefghijklmnop',
  );
  assert.match(out, /token=\[redacted\]/);
  assert.match(out, /Bearer \[redacted\]/);
});

test('redactString masks vendor token shapes', () => {
  const cases = [
    'oops: ya29.a0AfH6SMBxabcdefghijklmnopqrstuvwxyz1234',
    'refresh 1//0ab_-cdefghijklmnopqrstuvwxyz1234567890',
    'gmaps AIzaSyA1234567890abcdefghijklmnopqrstuvwx',
    'ci ghp_abcdefghijklmnopqrstuvwxyz1234567890',
    'oa sk-ant-abcdefghijklmnopqrstuvwxyz1234',
    'slack xoxb-1234567890-abcdefgh',
  ];
  for (const raw of cases) {
    assert.match(redactString(raw), /\[redacted\]/, `expected redaction in: ${raw}`);
  }
});

test('redact() handles cycles', () => {
  const a: Record<string, unknown> = { x: 1 };
  a['self'] = a;
  const r = redact(a) as Record<string, unknown>;
  assert.equal(r['x'], 1);
  assert.equal(r['self'], '[circular]');
});
