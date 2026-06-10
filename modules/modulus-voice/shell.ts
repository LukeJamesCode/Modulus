// Shared child-process plumbing for the voice shell pipelines (stt.ts whisper
// pipeline, synth.ts piper pipeline). Both spawn external binaries with
// pipeline-specific stdio/stdin wiring, then need the same timeout + output
// collection around the spawned child. The spawn itself stays in each module
// (their I/O shapes differ); this owns the event wiring they share.

import type { ChildProcess } from 'node:child_process';

// Hard cap on ffmpeg/whisper/piper wall time. These run inside the Telegram
// voice-message, afterReply, and speaker turn paths; without a kill a wedged
// binary hangs the turn forever. Short clips finish in well under a second, so
// 120s is generous.
export const SHELL_TIMEOUT_MS = 120_000;

export interface ShellResult {
  stdout: Buffer;
  stderr: string;
  code: number;
}

// Wire timeout, stderr accumulation, and (optionally) stdout collection onto an
// already-spawned child, resolving once it closes. `cmd` is only used for the
// timeout error message.
export function collectChildOutput(
  child: ChildProcess,
  cmd: string,
  opts: { collectStdout: boolean },
): Promise<ShellResult> {
  return new Promise((resolve, reject) => {
    const stdoutChunks: Buffer[] = [];
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`${cmd} timed out after ${SHELL_TIMEOUT_MS}ms`));
    }, SHELL_TIMEOUT_MS);
    timer.unref?.();
    if (opts.collectStdout) {
      child.stdout?.on('data', (c: Buffer) => stdoutChunks.push(c));
    }
    child.stderr?.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(stdoutChunks), stderr, code: code ?? -1 });
    });
  });
}
