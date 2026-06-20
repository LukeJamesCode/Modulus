// The perception->action loop, driven by a scripted fake vision backend and a
// recording control backend over a temp SQLite DB. Covers the safety-critical
// behaviours: actions execute in order, the app allowlist blocks acting on a
// disallowed window, Stop halts mid-run, and a sensitive action fails closed.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { open } from '../../src/storage/db.js';
import { createLogger } from '../../src/util/log.js';
import { createSessionManager } from './session.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationSql = readFileSync(join(here, 'migrations', '0001_init.sql'), 'utf8');
const log = createLogger({ level: 'error', out: () => {}, err: () => {} });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'modulus-cu-'));
  const db = open({ path: join(dir, 'test.db') });
  db.exec(migrationSql);
  return {
    db,
    dir,
    cleanup: () => {
      // Close first: WAL keeps the .db file locked, so rmSync would EBUSY.
      try {
        db.close();
      } catch {
        /* already closed */
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function fakeBackend(opts: { onClick?: () => void | Promise<void> } = {}) {
  const calls = {
    click: [] as Array<[number, number, string]>,
    type: [] as string[],
    key: [] as string[],
    capture: 0,
    foreground: 0,
  };
  let fg = { process: 'notepad', title: 'Untitled - Notepad' };
  const backend = {
    async capture(savePath: string) {
      calls.capture++;
      writeFileSync(savePath, Buffer.from('PNG'));
      return { base64: 'AAAA', path: savePath, width: 1920, height: 1080 };
    },
    async foreground() {
      calls.foreground++;
      return fg;
    },
    async click(x: number, y: number, button = 'left') {
      calls.click.push([x, y, button]);
      if (opts.onClick) await opts.onClick();
    },
    async type(text: string) {
      calls.type.push(text);
    },
    async key(combo: string) {
      calls.key.push(combo);
    },
    async scroll() {},
    async drag() {},
  };
  return { backend, calls, setForeground: (f: { process: string; title: string }) => (fg = f) };
}

function fakeVision(script: Array<Record<string, unknown>> | ((i: number) => Record<string, unknown>)) {
  let i = 0;
  return {
    async decide() {
      const d = typeof script === 'function' ? script(i++) : script[i++];
      if (!d) throw new Error('vision script exhausted');
      return d as never;
    },
    async describe() {
      return 'desc';
    },
  };
}

function cfg(over: Partial<{ appAllowlist: string[]; maxSteps: number; stepDelayMs: number }> = {}) {
  return {
    vision: { backend: 'local', localModel: 'vlm', cloudEndpoint: '', cloudModel: '', cloudApiKey: '' },
    appAllowlist: over.appAllowlist ?? ['notepad'],
    maxSteps: over.maxSteps ?? 10,
    stepDelayMs: over.stepDelayMs ?? 0,
  } as never;
}

test('runs scripted actions in order, then finishes done', async () => {
  const { db, dir, cleanup } = setup();
  try {
    const { backend, calls } = fakeBackend();
    const events: string[] = [];
    const vision = fakeVision([
      { action: 'click', args: { x: 100, y: 200 }, rationale: 'open menu' },
      { action: 'type', args: { text: 'hello' }, rationale: 'type greeting' },
      { action: 'done', args: { summary: 'typed it' }, rationale: '' },
    ]);
    const mgr = createSessionManager(
      {
        db,
        backend: backend as never,
        vision: vision as never,
        log,
        dataDir: dir,
        emit: (ev) => {
          events.push(`${ev.type}:${ev.status ?? ev.action}`);
        },
        sleep: async () => {},
      },
      () => cfg(),
    );
    const { sessionId, done } = mgr.start({ goal: 'type hello' });
    await done;

    assert.deepEqual(calls.click, [[100, 200, 'left']]);
    assert.deepEqual(calls.type, ['hello']);
    const session = db
      .prepare('SELECT status, summary FROM computer_use_sessions WHERE id = ?')
      .get(sessionId) as { status: string; summary: string };
    assert.equal(session.status, 'done');
    assert.match(session.summary, /typed it/);
    assert.ok(events.includes('status:running'));
    assert.ok(events.includes('status:done'));
  } finally {
    cleanup();
  }
});

test('blocks acting when the foreground app is not allowlisted', async () => {
  const { db, dir, cleanup } = setup();
  try {
    const { backend, calls, setForeground } = fakeBackend();
    setForeground({ process: 'chrome', title: 'Bank - Chrome' });
    const vision = fakeVision(() => ({ action: 'click', args: { x: 1, y: 2 }, rationale: '' }));
    const mgr = createSessionManager(
      { db, backend: backend as never, vision: vision as never, log, dataDir: dir, sleep: async () => {} },
      () => cfg({ appAllowlist: ['notepad'], maxSteps: 2 }),
    );
    const { sessionId, done } = mgr.start({ goal: 'do thing' });
    await done;

    assert.deepEqual(calls.click, [], 'never clicked in a disallowed window');
    assert.equal(calls.capture, 0, 'never even screenshotted a disallowed window');
    const blocked = db
      .prepare(`SELECT COUNT(*) AS n FROM computer_use_steps WHERE session_id = ? AND outcome = 'blocked'`)
      .get(sessionId) as { n: number };
    assert.ok(blocked.n >= 1, 'recorded blocked steps');
  } finally {
    cleanup();
  }
});

test('Stop halts the loop mid-run', async () => {
  const { db, dir, cleanup } = setup();
  try {
    let resolveClicked!: () => void;
    const clicked = new Promise<void>((r) => (resolveClicked = r));
    const { backend } = fakeBackend({ onClick: () => resolveClicked() });
    const vision = fakeVision(() => ({ action: 'click', args: { x: 1, y: 2 }, rationale: '' }));
    const mgr = createSessionManager(
      {
        db,
        backend: backend as never,
        vision: vision as never,
        log,
        dataDir: dir,
        // Real (tiny) delay so Stop lands before the next iteration's abort check.
        sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
      },
      () => cfg({ maxSteps: 50, stepDelayMs: 5 }),
    );
    const { sessionId, done } = mgr.start({ goal: 'loop forever' });
    await clicked;
    assert.equal(mgr.stop(), true);
    await done;

    const session = db
      .prepare('SELECT status FROM computer_use_sessions WHERE id = ?')
      .get(sessionId) as { status: string };
    assert.equal(session.status, 'stopped');
    assert.equal(mgr.isActive(), false);
  } finally {
    cleanup();
  }
});

test('a sensitive action fails closed (pauses) with no approver wired', async () => {
  const { db, dir, cleanup } = setup();
  try {
    const { backend, calls } = fakeBackend();
    const vision = fakeVision([
      { action: 'click', args: { x: 9, y: 9 }, rationale: 'click the Send button to send the email' },
    ]);
    const mgr = createSessionManager(
      { db, backend: backend as never, vision: vision as never, log, dataDir: dir, sleep: async () => {} },
      () => cfg(),
    );
    const { sessionId, done } = mgr.start({ goal: 'send email' });
    await done;

    assert.deepEqual(calls.click, [], 'sensitive click was not executed');
    const session = db
      .prepare('SELECT status FROM computer_use_sessions WHERE id = ?')
      .get(sessionId) as { status: string };
    assert.equal(session.status, 'paused');
  } finally {
    cleanup();
  }
});

test('refuses to start a second session while one is running', async () => {
  const { db, dir, cleanup } = setup();
  try {
    let resolveClicked!: () => void;
    const clicked = new Promise<void>((r) => (resolveClicked = r));
    const { backend } = fakeBackend({ onClick: () => resolveClicked() });
    const vision = fakeVision(() => ({ action: 'click', args: { x: 1, y: 1 }, rationale: '' }));
    const mgr = createSessionManager(
      {
        db,
        backend: backend as never,
        vision: vision as never,
        log,
        dataDir: dir,
        sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
      },
      () => cfg({ maxSteps: 50, stepDelayMs: 5 }),
    );
    const first = mgr.start({ goal: 'one' });
    await clicked;
    assert.throws(() => mgr.start({ goal: 'two' }), /already running/);
    mgr.stop();
    await first.done;
  } finally {
    cleanup();
  }
});
