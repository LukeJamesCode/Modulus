// Root-pinned, read-only filesystem tools (read_file / list_dir).
//
// The pinned root is resolved per-call from the tool context, not fixed at
// setup, so the same two tools serve two sources (see cli/start.ts):
//   • a global MODULUS_FS_ROOT the operator sets, and
//   • a per-task attachment directory, when files/folders were dropped into the
//     agent task this call belongs to.
// When neither applies the call resolves to no root and the tool says so.
//
// Security boundary: every path the model passes is resolved against the active
// root and then realpath-checked, so neither `../` segments nor a symlink that
// points outside the root can escape. Reads are size-capped and directory
// listings entry-capped so a stray call can't exhaust memory or context on a
// Pi. The tools are read-only — there is deliberately no write/delete tool.

import { realpath, readFile, readdir, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import type { Logger } from '../util/log.js';
import type { ToolRegistry, ToolContext } from './tools.js';

// Cap a single read so one file can't blow the prompt budget or RAM on a small
// box. The orchestrator's toolResultMaxChars trims further on injection; this is
// the hard I/O ceiling. ~256 KB covers any realistic source file.
export const MAX_READ_BYTES = 256 * 1024;
// Cap directory listings so a node_modules-sized folder returns a usable,
// bounded result rather than tens of thousands of lines.
export const MAX_DIR_ENTRIES = 500;

const NO_ROOT_MSG = 'No files are attached to this task and no review root is configured.';

export interface FilesystemToolsDeps {
  tools: ToolRegistry;
  log: Logger;
  // The directory this call is pinned to, resolved from the tool context (the
  // task's attachment dir, else a global root), or null when neither applies.
  resolveRoot: (ctx: ToolContext) => string | null;
}

// Resolve a model-supplied path against the pinned root and confirm it stays
// inside it, following symlinks. Returns the real absolute path, or an error
// string the model sees (so it can correct rather than the handler throwing an
// opaque message). `realRoot` is the already-realpath'd root.
async function resolveWithin(
  realRoot: string,
  rel: string,
): Promise<{ abs: string } | { err: string }> {
  if (typeof rel !== 'string' || rel.trim() === '') {
    return { err: 'path is required.' };
  }
  // Lexical fast-reject: absolute inputs and obvious traversal never get to the
  // filesystem. The realpath check below is the authoritative guard, but this
  // keeps the common mistake cheap and gives a clear message.
  if (isAbsolute(rel)) {
    return { err: 'path must be relative to the review root, not absolute.' };
  }
  const abs = resolve(realRoot, rel);
  const within = relative(realRoot, abs);
  if (within.startsWith('..') || isAbsolute(within)) {
    return { err: `path escapes the review root: ${rel}` };
  }
  let real: string;
  try {
    real = await realpath(abs);
  } catch {
    return { err: `no such file or directory: ${rel}` };
  }
  // Re-check after symlink resolution: a symlink inside the root could point
  // outside it. relative() of the root onto itself is '' (inside); a sibling
  // dir sharing a prefix (root '/a/b', target '/a/bx') yields '..'.
  const realWithin = relative(realRoot, real);
  if (realWithin !== '' && (realWithin.startsWith('..') || isAbsolute(realWithin))) {
    return { err: `path escapes the review root: ${rel}` };
  }
  return { abs: real };
}

export function setupFilesystemTools(deps: FilesystemToolsDeps): void {
  const log = deps.log.child({ mod: 'fs-tools' });
  // The active root may itself be a symlink; containment compares realpath
  // against realpath. realpath is async, so memoize per resolved-root string.
  const realRootCache = new Map<string, string>();
  // Resolve the active root for this call (or null). Returns the realpath'd root.
  const activeRoot = async (ctx: ToolContext): Promise<string | null> => {
    const configured = deps.resolveRoot(ctx);
    if (!configured) return null;
    const key = resolve(configured);
    const cached = realRootCache.get(key);
    if (cached) return cached;
    const real = await realpath(key).catch(() => key);
    realRootCache.set(key, real);
    return real;
  };

  deps.tools.register({
    name: 'list_dir',
    description:
      'List the files and subdirectories of a directory inside the review root. ' +
      'Paths are relative to that root; omit `path` (or pass ".") for the root itself. ' +
      'Directory names are suffixed with "/". Read-only.',
    tier: 'auto',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory path relative to the review root. Defaults to "." (the root).',
        },
      },
    },
    invoke: async (args, ctx) => {
      const root = await activeRoot(ctx);
      if (!root) return NO_ROOT_MSG;
      const rel = String(args['path'] ?? '.').trim() || '.';
      const r = await resolveWithin(root, rel);
      if ('err' in r) return r.err;
      let st;
      try {
        st = await stat(r.abs);
      } catch {
        return `no such file or directory: ${rel}`;
      }
      if (!st.isDirectory()) return `not a directory: ${rel} (use read_file for a file)`;
      const entries = await readdir(r.abs, { withFileTypes: true });
      const lines = entries
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort((a, b) => a.localeCompare(b));
      const shown = lines.slice(0, MAX_DIR_ENTRIES);
      const header = rel === '.' ? '(root)' : rel;
      const more =
        lines.length > shown.length
          ? `\n… ${lines.length - shown.length} more entries (showing first ${MAX_DIR_ENTRIES})`
          : '';
      return `${header}:\n${shown.join('\n')}${more}`;
    },
  });

  deps.tools.register({
    name: 'read_file',
    description:
      'Read the contents of a text file inside the review root. The path is relative to ' +
      'that root. Use list_dir first to discover paths. Large files are truncated. Read-only.',
    tier: 'auto',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the review root.' },
      },
      required: ['path'],
    },
    invoke: async (args, ctx) => {
      const root = await activeRoot(ctx);
      if (!root) return NO_ROOT_MSG;
      const rel = String(args['path'] ?? '').trim();
      const r = await resolveWithin(root, rel);
      if ('err' in r) return r.err;
      let st;
      try {
        st = await stat(r.abs);
      } catch {
        return `no such file or directory: ${rel}`;
      }
      if (st.isDirectory()) return `not a file: ${rel} (use list_dir for a directory)`;
      if (!st.isFile()) return `not a regular file: ${rel}`;
      const buf = await readFile(r.abs);
      // Refuse binaries (images, the SQLite DB, compiled output): a NUL byte in
      // the leading window is a reliable text/binary discriminator and stops the
      // tool from flooding the model's context with mojibake it can't review.
      const window = buf.subarray(0, Math.min(buf.length, MAX_READ_BYTES));
      if (window.includes(0)) return `binary file (not shown): ${rel}`;
      if (buf.length > MAX_READ_BYTES) {
        const head = window.toString('utf8');
        return `${head}\n\n[truncated: ${rel} is ${buf.length} bytes; showing first ${MAX_READ_BYTES}]`;
      }
      return buf.toString('utf8');
    },
  });

  log.info('filesystem tools registered (read_file, list_dir)');
}
