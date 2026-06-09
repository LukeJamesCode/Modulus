// Attachment ingestion classifies a drop, lands its bytes in the right place,
// and exposes them to the run: text/code/folders + extracted PDF text under
// files/ (the pinned read_file root), images base64-loadable for a multimodal
// model. These encode WHY the module exists — turning a drop into something the
// agent can actually consume — not just that files get written.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { open } from '../storage/db.js';
import { createAgentRegistry, type AgentRegistry } from './agents.js';
import { mkdirSync, writeFileSync as writeFile } from 'node:fs';
import {
  ingestAttachment,
  ingestStagedDir,
  pinnedFilesRoot,
  loadImageAttachmentsBase64,
  taskFilesDir,
  classifyKind,
  readStagedAttachments,
  removeStagedBatch,
  MAX_ATTACHMENT_BYTES,
} from './agent-attachments.js';

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'modulus-att-'));
  const db = open({ path: join(dir, 'g.db') });
  const registry = createAgentRegistry(db);
  const agent = registry.create({ name: 'a', systemPrompt: 's', toolAllowlist: [] });
  const task = registry.enqueue({ agentId: agent.id, prompt: 'go' });
  const baseDir = join(dir, 'attachments');
  return {
    registry,
    baseDir,
    taskId: task.id,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function ingestText(
  registry: AgentRegistry,
  baseDir: string,
  taskId: number,
  relPath: string,
  body: string,
) {
  return ingestAttachment({ registry, baseDir, taskId, relPath, bytes: Buffer.from(body) });
}

test('classifyKind keys off extension/mime', () => {
  assert.equal(classifyKind('a.png'), 'image');
  assert.equal(classifyKind('a.PDF'), 'pdf');
  assert.equal(classifyKind('a.ts'), 'file');
  assert.equal(classifyKind('noext', 'image/jpeg'), 'image');
});

test('ingest: a text file lands under files/ and pins that dir', async () => {
  const h = harness();
  try {
    const res = await ingestText(
      h.registry,
      h.baseDir,
      h.taskId,
      'src/index.ts',
      'export const x=1;',
    );
    assert.ok(res.ok);
    const filesDir = taskFilesDir(h.baseDir, h.taskId);
    assert.equal(readFileSync(join(filesDir, 'src', 'index.ts'), 'utf8'), 'export const x=1;');
    // The pinned root for read_file/list_dir is the files/ dir now that it's non-empty.
    assert.equal(pinnedFilesRoot(h.baseDir, h.taskId), filesDir);
    // Recorded as a 'file' attachment.
    assert.equal(h.registry.listAttachments(h.taskId)[0]!.kind, 'file');
  } finally {
    h.cleanup();
  }
});

test('ingest: rejects a path that escapes the task dir', async () => {
  const h = harness();
  try {
    const res = await ingestText(h.registry, h.baseDir, h.taskId, '../../etc/passwd', 'x');
    assert.equal(res.ok, false);
    assert.equal(h.registry.listAttachments(h.taskId).length, 0);
  } finally {
    h.cleanup();
  }
});

test('ingest: a PDF is extracted to text under files/, not stored as binary', async () => {
  const h = harness();
  try {
    const pdf = await PDFDocument.create();
    pdf.addPage().drawText('Hello from the PDF');
    const bytes = Buffer.from(await pdf.save());
    const res = await ingestAttachment({
      registry: h.registry,
      baseDir: h.baseDir,
      taskId: h.taskId,
      relPath: 'spec.pdf',
      bytes,
      mime: 'application/pdf',
    });
    assert.ok(res.ok);
    const att = h.registry.listAttachments(h.taskId)[0]!;
    assert.equal(att.kind, 'pdf');
    // Extracted text sidecar is readable text under files/ (so read_file sees it).
    const filesDir = taskFilesDir(h.baseDir, h.taskId);
    assert.ok(existsSync(join(filesDir, 'spec.pdf.txt')));
    assert.match(readFileSync(join(filesDir, 'spec.pdf.txt'), 'utf8'), /Hello from the PDF/);
  } finally {
    h.cleanup();
  }
});

test('ingest: an image lands under images/ and is base64-loadable; does not pin files/', async () => {
  const h = harness();
  try {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    const res = await ingestAttachment({
      registry: h.registry,
      baseDir: h.baseDir,
      taskId: h.taskId,
      relPath: 'shot.png',
      bytes: pngBytes,
      mime: 'image/png',
    });
    assert.ok(res.ok);
    assert.equal(h.registry.listAttachments(h.taskId)[0]!.kind, 'image');
    // Images don't make files/ a pinned root.
    assert.equal(pinnedFilesRoot(h.baseDir, h.taskId), null);
    const b64 = loadImageAttachmentsBase64(h.registry, h.baseDir, h.taskId);
    assert.equal(b64.length, 1);
    assert.equal(b64[0], pngBytes.toString('base64'));
  } finally {
    h.cleanup();
  }
});

test('ingestStagedDir: ingests a folder, gating images out when not multimodal', async () => {
  const h = harness();
  try {
    // Stage a folder with a code file and a screenshot.
    const staging = join(h.baseDir, 'staging', 'tok1');
    mkdirSync(join(staging, 'src'), { recursive: true });
    writeFile(join(staging, 'src', 'a.ts'), 'export const a = 1;');
    writeFile(join(staging, 'shot.png'), Buffer.from([0x89, 0x50]));

    // Text-only agent: the image is rejected, the code file still lands.
    const r = await ingestStagedDir({
      registry: h.registry,
      baseDir: h.baseDir,
      taskId: h.taskId,
      stagingDir: staging,
      allowVisual: false,
    });
    assert.equal(r.ingested, 1);
    assert.equal(r.rejected.length, 1);
    assert.match(r.rejected[0]!, /multimodal/);
    const kinds = h.registry.listAttachments(h.taskId).map((a) => a.kind);
    assert.deepEqual(kinds, ['file']);
    // Folder structure preserved under files/.
    assert.equal(
      readFileSync(join(taskFilesDir(h.baseDir, h.taskId), 'src', 'a.ts'), 'utf8'),
      'export const a = 1;',
    );
  } finally {
    h.cleanup();
  }
});

test('ingestStagedDir keepStaging:true leaves the batch for sibling consumers', async () => {
  const h = harness();
  try {
    const staging = join(h.baseDir, 'staging', 'tok-keep');
    mkdirSync(staging, { recursive: true });
    writeFile(join(staging, 'a.ts'), 'export const a = 1;');
    const r = await ingestStagedDir({
      registry: h.registry,
      baseDir: h.baseDir,
      taskId: h.taskId,
      stagingDir: staging,
      allowVisual: false,
      keepStaging: true,
    });
    assert.equal(r.ingested, 1);
    // Batch is still on disk — a second agent node could ingest the same files.
    assert.equal(existsSync(join(staging, 'a.ts')), true);
    // removeStagedBatch(token) is the single cleanup the runner calls at run end.
    removeStagedBatch(h.baseDir, 'tok-keep');
    assert.equal(existsSync(staging), false);
  } finally {
    h.cleanup();
  }
});

test('readStagedAttachments: images→base64, files→text, oversize rejected (no registry, for chat)', async () => {
  const h = harness();
  try {
    const staging = join(h.baseDir, 'staging', 'chat-tok');
    mkdirSync(staging, { recursive: true });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    writeFile(join(staging, 'shot.png'), png);
    writeFile(join(staging, 'notes.txt'), 'remember the milk');
    writeFile(join(staging, 'huge.txt'), Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 0x61));

    const r = await readStagedAttachments(staging);
    // Image comes back base64 for messages[].images — never written to a task dir.
    assert.equal(r.images.length, 1);
    assert.equal(r.images[0]!.base64, png.toString('base64'));
    // Text file content is inlined verbatim for the prompt.
    assert.equal(r.texts.find((t) => t.name === 'notes.txt')?.text, 'remember the milk');
    // The over-cap file is reported, not silently dropped (Pi RAM guard).
    assert.equal(
      r.texts.some((t) => t.name === 'huge.txt'),
      false,
    );
    assert.match(r.rejected.join(' '), /huge\.txt.*too large/);
  } finally {
    h.cleanup();
  }
});

test('pinnedFilesRoot is null when nothing has been dropped', () => {
  const h = harness();
  try {
    assert.equal(pinnedFilesRoot(h.baseDir, h.taskId), null);
  } finally {
    h.cleanup();
  }
});
