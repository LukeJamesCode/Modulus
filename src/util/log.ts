// Structured logger. JSON-lines on stdout for info+, stderr for warn+. Level
// filter from MODULUS_LOG_LEVEL (debug | info | warn | error). All payloads
// pass through redact() before serialization so a stray token never lands in
// the log.
//
// When `file` is set every line is also appended there — `modulus start`
// points this at ~/.modulus/log/modulus.log so `modulus logs` can tail it.

import { appendFileSync, chmodSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { redact } from './redact.js';

export type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  level?: Level;
  // Override sinks for tests.
  out?: (line: string) => void;
  err?: (line: string) => void;
  // Override the clock for tests.
  now?: () => Date;
  bindings?: Record<string, unknown>;
  // Mirror every line into this file (in addition to stdout/stderr).
  file?: string;
}

function parseLevel(raw: string | undefined, fallback: Level): Level {
  if (!raw) return fallback;
  const v = raw.toLowerCase();
  if (v === 'debug' || v === 'info' || v === 'warn' || v === 'error') return v;
  return fallback;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const level = opts.level ?? parseLevel(process.env['MODULUS_LOG_LEVEL'], 'info');
  const threshold = LEVELS[level];
  const fileSink = opts.file ? makeFileSink(opts.file) : null;
  const out =
    opts.out ??
    ((l: string) => {
      process.stdout.write(l + '\n');
      fileSink?.(l);
    });
  const err =
    opts.err ??
    ((l: string) => {
      process.stderr.write(l + '\n');
      fileSink?.(l);
    });
  const now = opts.now ?? (() => new Date());
  const bindings = opts.bindings ?? {};

  function emit(lvl: Level, msg: string, fields?: Record<string, unknown>): void {
    if (LEVELS[lvl] < threshold) return;
    const record = {
      t: now().toISOString(),
      level: lvl,
      msg,
      ...bindings,
      ...(fields ?? {}),
    };
    const safe = redact(record);
    let line: string;
    try {
      line = JSON.stringify(safe);
    } catch {
      line = JSON.stringify({
        t: now().toISOString(),
        level: 'error',
        msg: 'log serialization failed',
        original: msg,
      });
    }
    if (LEVELS[lvl] >= LEVELS.warn) err(line);
    else out(line);
  }

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (b) => createLogger({ ...opts, level, bindings: { ...bindings, ...b } }),
  };
}

// One sink per path, shared across every child logger pointed at that file.
// `createLogger` is called once per turn and per tool (orchestrator child
// loggers), so building a fresh sink — and re-running the existsSync/chmod
// setup — on each call was pure overhead. Memoizing also means the one-time
// chmod work happens exactly once per process per file.
const fileSinks = new Map<string, (line: string) => void>();

function makeFileSink(path: string): (line: string) => void {
  const existing = fileSinks.get(path);
  if (existing) return existing;

  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Best-effort on filesystems without POSIX permissions.
  }
  // Tighten an already-existing log file once at sink creation. New files get
  // 0o600 from appendFileSync's mode below, so we no longer chmod per line.
  try {
    chmodSync(path, 0o600);
  } catch {
    // File may not exist yet, or the FS has no POSIX perms — both fine.
  }
  const sink = (line: string): void => {
    try {
      appendFileSync(path, line + '\n', { mode: 0o600 });
    } catch {
      // Don't let log-write failures crash the process. stdout/stderr already
      // got the line; the file mirror is best-effort.
    }
  };
  fileSinks.set(path, sink);
  return sink;
}
