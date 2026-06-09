// Filesystem tools must (1) read/list inside the pinned root, and (2) refuse to
// escape it — via absolute paths, `..` traversal, or a symlink that points
// outside. The escape cases are the reason this module exists as a guarded
// capability rather than a raw fs.readFile, so they are the load-bearing tests.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../util/log.js';
import { createToolRegistry, type ToolContext } from './tools.js';
import { setupFilesystemTools, MAX_READ_BYTES } from './fs-tools.js';

function silentLogger() {
  return createLogger({ level: 'error', out: () => {}, err: () => {} });
}

function ctx(): ToolContext {
  return { log: silentLogger() };
}

// Build a temp tree: <root>/repo with a file + subdir, and a secret file OUTSIDE
// the root that escape attempts will aim at. Returns the registry + the root.
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'modulus-fs-'));
  const root = join(base, 'repo');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'README.md'), '# hello\n');
  writeFileSync(join(root, 'src', 'index.ts'), 'export const x = 1;\n');
  writeFileSync(join(base, 'secret.txt'), 'TOP SECRET\n');
  const tools = createToolRegistry({ log: silentLogger() });
  setupFilesystemTools({ tools, log: silentLogger(), resolveRoot: () => root });
  return {
    base,
    root,
    tools,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

async function run(
  tools: ReturnType<typeof createToolRegistry>,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const res = await tools.execute({ id: 't', name, arguments: args }, ctx());
  return res.output;
}

test('fs-tools: a null resolver (no root for this call) tells the model so', async () => {
  const base = mkdtempSync(join(tmpdir(), 'modulus-fs-'));
  try {
    const tools = createToolRegistry({ log: silentLogger() });
    setupFilesystemTools({ tools, log: silentLogger(), resolveRoot: () => null });
    const out = await run(tools, 'read_file', { path: 'anything' });
    assert.match(out, /No files are attached|no review root/i);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('fs-tools: the root is resolved per call from the tool context', async () => {
  const base = mkdtempSync(join(tmpdir(), 'modulus-fs-'));
  try {
    const a = join(base, 'a');
    const b = join(base, 'b');
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    writeFileSync(join(a, 'only-in-a.txt'), 'A');
    writeFileSync(join(b, 'only-in-b.txt'), 'B');
    const tools = createToolRegistry({ log: silentLogger() });
    // Route chatId 1 -> a, anything else -> b, proving the resolver sees ctx.
    setupFilesystemTools({
      tools,
      log: silentLogger(),
      resolveRoot: (ctx) => (ctx.chatId === 1 ? a : b),
    });
    const fromA = await tools.execute(
      { id: 't', name: 'list_dir', arguments: {} },
      { log: silentLogger(), chatId: 1 },
    );
    const fromB = await tools.execute(
      { id: 't', name: 'list_dir', arguments: {} },
      { log: silentLogger(), chatId: 2 },
    );
    assert.match(fromA.output, /only-in-a\.txt/);
    assert.match(fromB.output, /only-in-b\.txt/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('fs-tools: list_dir lists the root and a subdir', async () => {
  const f = fixture();
  try {
    const root = await run(f.tools, 'list_dir', {});
    assert.match(root, /README\.md/);
    assert.match(root, /src\//); // directory suffixed with /
    const sub = await run(f.tools, 'list_dir', { path: 'src' });
    assert.match(sub, /index\.ts/);
  } finally {
    f.cleanup();
  }
});

test('fs-tools: read_file returns contents inside the root', async () => {
  const f = fixture();
  try {
    assert.equal(await run(f.tools, 'read_file', { path: 'README.md' }), '# hello\n');
    assert.equal(
      await run(f.tools, 'read_file', { path: 'src/index.ts' }),
      'export const x = 1;\n',
    );
  } finally {
    f.cleanup();
  }
});

test('fs-tools: refuses `..` traversal out of the root', async () => {
  const f = fixture();
  try {
    const out = await run(f.tools, 'read_file', { path: '../secret.txt' });
    assert.match(out, /escapes the review root|no such file/);
    assert.doesNotMatch(out, /TOP SECRET/);
  } finally {
    f.cleanup();
  }
});

test('fs-tools: refuses absolute paths', async () => {
  const f = fixture();
  try {
    const out = await run(f.tools, 'read_file', { path: join(f.base, 'secret.txt') });
    assert.match(out, /absolute/);
    assert.doesNotMatch(out, /TOP SECRET/);
  } finally {
    f.cleanup();
  }
});

test('fs-tools: refuses a symlink that points outside the root', async () => {
  const f = fixture();
  try {
    // A symlink living inside the root but targeting the external secret must
    // not be readable — lexical containment passes, realpath containment fails.
    try {
      symlinkSync(join(f.base, 'secret.txt'), join(f.root, 'leak.txt'));
    } catch {
      return; // symlink creation can be unprivileged-blocked on Windows; skip.
    }
    const out = await run(f.tools, 'read_file', { path: 'leak.txt' });
    assert.match(out, /escapes the review root/);
    assert.doesNotMatch(out, /TOP SECRET/);
  } finally {
    f.cleanup();
  }
});

test('fs-tools: refuses a binary file instead of returning mojibake', async () => {
  const f = fixture();
  try {
    writeFileSync(
      join(f.root, 'logo.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]),
    );
    const out = await run(f.tools, 'read_file', { path: 'logo.png' });
    assert.match(out, /binary file/);
  } finally {
    f.cleanup();
  }
});

test('fs-tools: truncates a file larger than the read cap', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'big.txt'), 'a'.repeat(MAX_READ_BYTES + 10));
    const out = await run(f.tools, 'read_file', { path: 'big.txt' });
    assert.match(out, /\[truncated:/);
    assert.ok(out.length < MAX_READ_BYTES + 200);
  } finally {
    f.cleanup();
  }
});
