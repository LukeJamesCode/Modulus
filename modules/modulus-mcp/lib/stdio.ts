// stdio transport for the MCP client. Launches an MCP server as a child process
// (through host.spawn, so the module tripwire enforces the binary allowlist) and
// speaks newline-delimited JSON-RPC over its stdin/stdout — the MCP stdio framing.
// stderr is the server's own diagnostics channel and is surfaced to the log.

import type { Readable, Writable } from 'node:stream';
import type { JsonRpcMessage, McpTransport } from './client.js';

// The slice of a child process this transport uses. A node ChildProcess satisfies
// it structurally, so tools.ts can pass host.spawn directly; tests pass a fake.
export interface StdioChild {
  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  kill(signal?: number | NodeJS.Signals): boolean;
}

export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv },
) => StdioChild;

export interface StdioTransportOptions {
  spawn: SpawnLike;
  command: string;
  args?: readonly string[];
  env?: NodeJS.ProcessEnv;
  // Server stderr lines (its own logs/diagnostics).
  onStderr?: (line: string) => void;
}

// Pull complete '\n'-delimited lines out of a rolling buffer, returning the
// remainder. Shared by the stdout (messages) and stderr (logs) readers.
function drainLines(buffer: string, onLine: (line: string) => void): string {
  let buf = buffer;
  for (;;) {
    const nl = buf.indexOf('\n');
    if (nl < 0) break;
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    onLine(line);
  }
  return buf;
}

export function createStdioTransport(opts: StdioTransportOptions): McpTransport {
  const child = opts.spawn(opts.command, opts.args ?? [], { env: opts.env ?? process.env });
  let onMsg: ((m: JsonRpcMessage) => void) | undefined;
  let onClose: ((err?: Error) => void) | undefined;

  let outBuf = '';
  child.stdout?.on('data', (chunk: Buffer | string) => {
    outBuf = drainLines(outBuf + chunk.toString(), (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(trimmed) as JsonRpcMessage;
      } catch {
        return; // a non-JSON line on stdout is not ours; ignore it
      }
      onMsg?.(msg);
    });
  });

  if (opts.onStderr) {
    let errBuf = '';
    child.stderr?.on('data', (chunk: Buffer | string) => {
      errBuf = drainLines(errBuf + chunk.toString(), (line) => {
        if (line.trim()) opts.onStderr?.(line);
      });
    });
  }

  child.on('exit', (code: unknown) => onClose?.(new Error(`MCP server exited (${String(code)})`)));
  child.on('error', (err: unknown) =>
    onClose?.(err instanceof Error ? err : new Error(String(err))),
  );

  return {
    send: async (message) => {
      if (!child.stdin) throw new Error('MCP server stdin is not available');
      child.stdin.write(JSON.stringify(message) + '\n');
    },
    onMessage: (h) => {
      onMsg = h;
    },
    onClose: (h) => {
      onClose = h;
    },
    close: async () => {
      try {
        child.stdin?.end();
      } catch {
        /* ignore — we're killing it anyway */
      }
      child.kill();
    },
  };
}
