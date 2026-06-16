// Ingestion + lookup for task input attachments (the "drop files into a task"
// feature). Bytes are stored on disk under a per-task directory; metadata rows
// go through AgentRegistry. Two destinations:
//   • files/   — text, code, whole folders, and extracted PDF text. This dir is
//                what read_file/list_dir is pinned to for the run.
//   • images/  — raster images, base64-fed to a multimodal model at run start.
//
// The base directory is injected (start.ts passes ~/.modulus/agent-attachments)
// so this core module never imports the cli/config layer.

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname, normalize, isAbsolute, extname, relative } from 'node:path';
import { extractText } from 'unpdf';
import type { AgentRegistry, AgentAttachment, AttachmentKind } from './agents.js';

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
// Skip absurd inputs early — protects a Pi's RAM/disk. The model/context caps
// downstream are separate; this is the per-file intake ceiling.
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export function taskDir(baseDir: string, taskId: number): string {
  return join(baseDir, String(taskId));
}
export function taskFilesDir(baseDir: string, taskId: number): string {
  return join(taskDir(baseDir, taskId), 'files');
}
export function taskImagesDir(baseDir: string, taskId: number): string {
  return join(taskDir(baseDir, taskId), 'images');
}

// The root read_file/list_dir should pin to for this task, or null when the task
// has no file/code/PDF-text attachments (images don't count — they go to the
// model, not the tools).
export function pinnedFilesRoot(baseDir: string, taskId: number): string | null {
  const dir = taskFilesDir(baseDir, taskId);
  if (!existsSync(dir)) return null;
  try {
    return readdirSync(dir).length > 0 ? dir : null;
  } catch {
    return null;
  }
}

export function classifyKind(name: string, mime?: string): AttachmentKind {
  const mod = extname(name).toLowerCase();
  if ((mime ?? '').startsWith('image/') || IMAGE_EXTS.has(mod)) return 'image';
  if ((mime ?? '') === 'application/pdf' || mod === '.pdf') return 'pdf';
  return 'file';
}

// Keep a dropped relative path inside the target dir: reject absolute paths and
// any `..` traversal (folder drops carry paths like "src/index.ts").
function safeRelative(relPath: string): string | null {
  const norm = normalize(relPath).replace(/^[/\\]+/, '');
  if (!norm || isAbsolute(norm) || norm.split(/[/\\]/).includes('..')) return null;
  return norm;
}

export type IngestResult =
  | { ok: true; attachment: AgentAttachment }
  | { ok: false; rejected: string };

// Ingest one dropped file's bytes. Classification decides the destination;
// folder structure is preserved for 'file' kinds via relPath, and PDFs are
// text-extracted into files/. The multimodal gate for images is enforced where
// it matters — at upload (the surface) and at run start (runTask, which refuses
// to feed images to a text-only model) — not here.
export async function ingestAttachment(opts: {
  registry: AgentRegistry;
  baseDir: string;
  taskId: number;
  relPath: string;
  bytes: Buffer;
  mime?: string;
}): Promise<IngestResult> {
  const { registry, baseDir, taskId, bytes, mime } = opts;
  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    return {
      ok: false,
      rejected: `${opts.relPath} is too large (max ${MAX_ATTACHMENT_BYTES} bytes)`,
    };
  }
  const rel = safeRelative(opts.relPath);
  if (!rel) return { ok: false, rejected: `invalid path: ${opts.relPath}` };
  const name = rel.split(/[/\\]/).pop() ?? rel;
  const kind = classifyKind(name, mime);

  if (kind === 'image') {
    const dir = taskImagesDir(baseDir, taskId);
    mkdirSync(dir, { recursive: true });
    const abs = join(dir, name);
    writeFileSync(abs, bytes);
    return {
      ok: true,
      attachment: registry.addAttachment({
        taskId,
        kind,
        name,
        path: join('images', name),
        ...(mime ? { mime } : {}),
        bytes: bytes.length,
      }),
    };
  }

  // file + pdf both land under files/ (the pinned read_file root).
  const filesDir = taskFilesDir(baseDir, taskId);
  if (kind === 'pdf') {
    let text: string;
    try {
      const res = await extractText(new Uint8Array(bytes), { mergePages: true });
      text = typeof res.text === 'string' ? res.text : (res.text as string[]).join('\n\n');
    } catch (e) {
      return {
        ok: false,
        rejected: `could not read PDF ${name}: ${e instanceof Error ? e.message : 'parse error'}`,
      };
    }
    const outRel = `${rel}.txt`;
    const abs = join(filesDir, outRel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text, 'utf8');
    return {
      ok: true,
      attachment: registry.addAttachment({
        taskId,
        kind,
        name,
        path: join('files', outRel),
        mime: 'text/plain',
        bytes: Buffer.byteLength(text),
      }),
    };
  }

  const abs = join(filesDir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, bytes);
  return {
    ok: true,
    attachment: registry.addAttachment({
      taskId,
      kind: 'file',
      name,
      path: join('files', rel),
      ...(mime ? { mime } : {}),
      bytes: bytes.length,
    }),
  };
}

// Recursively list every file (not directory) under a dir, as absolute paths.
function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(abs));
    else if (e.isFile()) out.push(abs);
  }
  return out;
}

// Ingest a batch of in-memory files into a task. Image/PDF drops are gated on
// `allowVisual` (the agent's multimodal capability, resolved by the caller);
// rejected ones are reported, not ingested. This is the single gate+ingest path
// shared by every surface — the panel (staged to disk) and Telegram (downloaded
// to memory) both funnel through here.
export async function ingestFiles(opts: {
  registry: AgentRegistry;
  baseDir: string;
  taskId: number;
  allowVisual: boolean;
  files: Array<{ relPath: string; bytes: Buffer; mime?: string }>;
}): Promise<{ ingested: number; rejected: string[] }> {
  const { registry, baseDir, taskId, allowVisual } = opts;
  const rejected: string[] = [];
  let ingested = 0;
  for (const f of opts.files) {
    const kind = classifyKind(f.relPath, f.mime);
    if (!allowVisual && kind !== 'file') {
      rejected.push(`${f.relPath} (needs a multimodal model)`);
      continue;
    }
    const r = await ingestAttachment({
      registry,
      baseDir,
      taskId,
      relPath: f.relPath,
      bytes: f.bytes,
      ...(f.mime ? { mime: f.mime } : {}),
    });
    if (r.ok) ingested += 1;
    else rejected.push(r.rejected);
  }
  return { ingested, rejected };
}

// Ingest every file staged under `stagingDir` into a task, preserving relative
// folder structure, then remove the staging dir. This is the panel's entry
// point — it stages raw bytes over HTTP, then calls this once on dispatch.
export async function ingestStagedDir(opts: {
  registry: AgentRegistry;
  baseDir: string;
  taskId: number;
  stagingDir: string;
  allowVisual: boolean;
}): Promise<{ ingested: number; rejected: string[] }> {
  const { registry, baseDir, taskId, stagingDir, allowVisual } = opts;
  if (!existsSync(stagingDir)) return { ingested: 0, rejected: [] };
  const files = walkFiles(stagingDir).map((abs) => ({
    relPath: relative(stagingDir, abs),
    bytes: readFileSync(abs),
  }));
  const result = await ingestFiles({ registry, baseDir, taskId, allowVisual, files });
  rmSync(stagingDir, { recursive: true, force: true });
  return result;
}

// Read a staged batch (raw bytes under stagingDir) into in-memory attachments
// for a turn-scoped surface that has no task to pin to — i.e. direct chat.
// Images come back base64 for a multimodal model's messages[].images; files and
// PDFs come back as extracted text the caller inlines into the prompt. The
// caller deletes stagingDir. Mirrors ingestFiles' classification, minus the
// registry/disk side effects.
export async function readStagedAttachments(stagingDir: string): Promise<{
  images: { name: string; base64: string }[];
  texts: { name: string; text: string }[];
  rejected: string[];
}> {
  const images: { name: string; base64: string }[] = [];
  const texts: { name: string; text: string }[] = [];
  const rejected: string[] = [];
  if (!existsSync(stagingDir)) return { images, texts, rejected };
  for (const abs of walkFiles(stagingDir)) {
    const rel = relative(stagingDir, abs);
    const name = rel.split(/[/\\]/).pop() ?? rel;
    let bytes: Buffer;
    try {
      bytes = readFileSync(abs);
    } catch {
      rejected.push(`${rel} (unreadable)`);
      continue;
    }
    if (bytes.length > MAX_ATTACHMENT_BYTES) {
      rejected.push(`${rel} is too large (max ${MAX_ATTACHMENT_BYTES} bytes)`);
      continue;
    }
    const kind = classifyKind(name);
    if (kind === 'image') {
      images.push({ name, base64: bytes.toString('base64') });
    } else if (kind === 'pdf') {
      try {
        const res = await extractText(new Uint8Array(bytes), { mergePages: true });
        const text = typeof res.text === 'string' ? res.text : (res.text as string[]).join('\n\n');
        texts.push({ name, text });
      } catch (e) {
        rejected.push(
          `could not read PDF ${name}: ${e instanceof Error ? e.message : 'parse error'}`,
        );
      }
    } else {
      texts.push({ name, text: bytes.toString('utf8') });
    }
  }
  return { images, texts, rejected };
}

// Base64 of every image attached to a task, in drop order, for a multimodal
// model's `messages[].images`. Missing files are skipped (best-effort).
export function loadImageAttachmentsBase64(
  registry: AgentRegistry,
  baseDir: string,
  taskId: number,
): string[] {
  const out: string[] = [];
  for (const att of registry.listAttachments(taskId)) {
    if (att.kind !== 'image') continue;
    const abs = join(taskDir(baseDir, taskId), att.path);
    try {
      out.push(readFileSync(abs).toString('base64'));
    } catch {
      /* a removed/unreadable image must not abort the run */
    }
  }
  return out;
}
