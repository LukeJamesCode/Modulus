import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../storage/db.js';
import { createAgentRegistry } from './agents.js';
import { applyKnob, describeAgentPlain, PLAIN_KNOB_NAMES } from './agent-knobs.js';

test('applyKnob round-trips each plain knob onto the right field', () => {
  assert.deepEqual(applyKnob({}, 'brainpower', 'quick'), { patch: { profile: 'chat' } });
  assert.deepEqual(applyKnob({}, 'brainpower', 'balanced'), { patch: { profile: 'tools' } });
  assert.deepEqual(applyKnob({}, 'brainpower', 'deep'), { patch: { profile: 'reason' } });
  assert.deepEqual(applyKnob({}, 'think', 'on'), { patch: { thinkMode: 'on' } });
  assert.deepEqual(applyKnob({}, 'think', 'auto'), { patch: { thinkMode: 'auto' } });
  assert.deepEqual(applyKnob({}, 'solo', 'on'), { patch: { mode: 'autonomous' } });
  assert.deepEqual(applyKnob({}, 'solo', 'off'), { patch: { mode: 'single' } });
  assert.deepEqual(applyKnob({}, 'delegate', 'on'), { patch: { canDelegate: true } });
  assert.deepEqual(applyKnob({}, 'rounds', '6'), { patch: { maxToolRounds: 6 } });
  // tools: list, all → null, none → [].
  assert.deepEqual(applyKnob({}, 'tools', 'modulus-websearch, modulus-codex'), {
    patch: { toolAllowlist: ['modulus-websearch', 'modulus-codex'] },
  });
  assert.deepEqual(applyKnob({}, 'tools', 'all'), { patch: { toolAllowlist: null } });
  assert.deepEqual(applyKnob({}, 'tools', 'none'), { patch: { toolAllowlist: [] } });
});

test('applyKnob is case-insensitive on the knob name and merges into the prior patch', () => {
  const r = applyKnob({ role: 'x' }, 'BrainPower', 'deep');
  assert.deepEqual(r, { patch: { role: 'x', profile: 'reason' } });
});

test('applyKnob rejects bad knobs and bad values', () => {
  const unknown = applyKnob({}, 'turbo', 'on');
  assert.ok('error' in unknown && /Unknown setting 'turbo'/.test(unknown.error));
  // The error lists the valid knob names so the user can recover.
  for (const name of PLAIN_KNOB_NAMES) {
    assert.ok('error' in unknown && unknown.error.includes(name));
  }
  assert.ok('error' in applyKnob({}, 'brainpower', 'galaxy'));
  assert.ok('error' in applyKnob({}, 'think', 'maybe'));
  assert.ok('error' in applyKnob({}, 'solo', 'kinda'));
  assert.ok('error' in applyKnob({}, 'rounds', '0'));
  assert.ok('error' in applyKnob({}, 'rounds', '99'));
  assert.ok('error' in applyKnob({}, 'rounds', 'lots'));
});

test('describeAgentPlain renders profile/think/mode/tools in plain words', () => {
  const dir = mkdtempSync(join(tmpdir(), 'modulus-knobs-'));
  try {
    const db = open({ path: join(dir, 'g.db') });
    const reg = createAgentRegistry(db);
    const agent = reg.create({
      name: 'scribe',
      role: 'writes things',
      systemPrompt: 'x',
      profile: 'reason',
      thinkMode: 'on',
      mode: 'autonomous',
      canDelegate: true,
      toolAllowlist: [],
    });
    const out = describeAgentPlain(agent);
    assert.match(out, /scribe — writes things/);
    assert.match(out, /brainpower: deep/);
    assert.match(out, /think: on/);
    assert.match(out, /solo: on/);
    assert.match(out, /delegate: on/);
    assert.match(out, /tools: no tools/);

    // A plain chat agent with all tools reads the other way.
    const plain = reg.create({ name: 'helper', systemPrompt: 'x', profile: 'chat' });
    const out2 = describeAgentPlain(plain);
    assert.match(out2, /brainpower: quick/);
    assert.match(out2, /think: auto/);
    assert.match(out2, /solo: off/);
    assert.match(out2, /tools: all tools/);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('describeAgentPlain flags module-owned (read-only) agents', () => {
  const dir = mkdtempSync(join(tmpdir(), 'modulus-knobs-'));
  try {
    const db = open({ path: join(dir, 'g.db') });
    const reg = createAgentRegistry(db);
    const agent = reg.create({
      name: 'modbot',
      systemPrompt: 'x',
      origin: 'module:modulus-demo',
    });
    assert.match(describeAgentPlain(agent), /provided by module:modulus-demo — read-only/);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
