// `modulus logs [--follow]` — stream ~/.modulus/log/modulus.log.
//
// One-shot mode prints the whole file. --follow keeps reading new bytes as
// they're appended, like `tail -f` but without shelling out.

import { existsSync, statSync, watchFile, createReadStream, unwatchFile } from 'node:fs';
import { homeDir } from './config-store.js';
import { logFilePath } from './daemon.js';

export interface LogsOptions {
  follow?: boolean;
  // Number of bytes from the end to print first (--follow only). Default: 4 KB.
  tailBytes?: number;
}

export async function run(opts: LogsOptions = {}): Promise<void> {
  const file = logFilePath(homeDir());
  if (!existsSync(file)) {
    process.stderr.write(`No log file at ${file}. Has modulus been started?\n`);
    process.exit(1);
  }

  if (!opts.follow) {
    await streamWholeFile(file);
    return;
  }

  await streamTailThenFollow(file, opts.tailBytes ?? 4096);
}

async function streamWholeFile(file: string): Promise<void> {
  await new Promise<void>((resolveP, reject) => {
    const s = createReadStream(file, { encoding: 'utf8' });
    s.on('data', (c) => process.stdout.write(c));
    s.on('error', reject);
    s.on('end', () => resolveP());
  });
}

async function streamTailThenFollow(file: string, tailBytes: number): Promise<void> {
  // Snapshot the end BEFORE reading and read only up to it, then advance `pos`
  // by exactly that span. Re-statting after the read would skip any bytes the
  // daemon appended between EOF and the stat.
  const initialEnd = statSync(file).size;
  let pos = Math.max(0, initialEnd - tailBytes);
  await streamFrom(file, pos, initialEnd);
  pos = initialEnd;

  // Two timer ticks during a noisy log burst can both pass the size guard and
  // both call streamFrom() from the same `pos`, duplicating output. The lock
  // serialises reads; if a burst arrives while we're still draining, the next
  // tick will see the updated `pos` and pick up where we stopped.
  let reading = false;
  watchFile(file, { interval: 500 }, (curr, prev) => {
    if (curr.size < prev.size) {
      pos = 0;
      return;
    }
    if (reading) return;
    if (curr.size > pos) {
      reading = true;
      // Bound the read to the size from this watch event. Anything appended
      // after will fire another watch tick and be picked up from the new `pos`.
      const end = curr.size;
      streamFrom(file, pos, end)
        .then(() => {
          pos = end;
        })
        .catch(() => {
          /* ignore transient read errors during rotation */
        })
        .finally(() => {
          reading = false;
        });
    }
  });

  // Keep the process alive until SIGINT.
  await new Promise<void>((resolveP) => {
    process.once('SIGINT', () => {
      unwatchFile(file);
      resolveP();
    });
  });
}

async function streamFrom(file: string, start: number, end: number): Promise<void> {
  // `end` is an exclusive byte offset; createReadStream's `end` is inclusive.
  if (end <= start) return;
  await new Promise<void>((resolveP, reject) => {
    const s = createReadStream(file, { encoding: 'utf8', start, end: end - 1 });
    s.on('data', (c) => process.stdout.write(c));
    s.on('error', reject);
    s.on('end', () => resolveP());
  });
}
