// Marketplace installer core. The panel's Modules tab and the CLI both drive
// module installs through this one pipeline:
//
//   index.json  →  download tarball  →  sha256 verify  →  strict extract
//   →  manifest validation  →  [caller shows consent]  →  commit into place
//
// Threat model: the registry index is curated, but the transport and hosting
// (GitHub Releases / any CDN) are not trusted beyond TLS. Every artifact is
// pinned by sha256 in the index, so a swapped or tampered tarball fails closed
// before a byte of it is interpreted. Extraction is a deliberately minimal
// ustar reader that accepts ONLY regular files and directories with safe
// relative paths — symlinks, hardlinks, devices, pax/gnu modules, absolute
// paths, and `..` traversal are hard errors, not skipped entries. That
// strictness (not a full tar implementation) is the security boundary, and it
// keeps core free of a tar dependency.
//
// Consent is the CALLER's job, by design: stageModule() returns the staged
// module with its declared permissions; the UI renders the consent screen
// (re-consent on permissionDiff() additions for updates) and only then calls
// commitModule(). Nothing executes from a staged directory.

import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type { Logger } from '../util/log.js';

// 50 MB compressed. Modules are code + small assets; anything bigger should
// download its payloads at runtime (like the voice/whisper installers do).
export const DEFAULT_MAX_TARBALL_BYTES = 50 * 1024 * 1024;
// Decompression bomb guard: a tiny .tgz may not expand past this.
export const DEFAULT_MAX_UNPACKED_BYTES = 200 * 1024 * 1024;

const MODULE_NAME_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;

export interface ModulePermissions {
  // Domains the module may contact, subprocess binaries it may spawn, and
  // filesystem roots it may touch. Declarative for the consent screen; the
  // runtime tripwires that enforce them land separately.
  network?: string[];
  subprocess?: string[];
  filesystem?: string[];
}

export interface RegistryIndexEntry {
  name: string;
  displayName?: string;
  version: string;
  description?: string;
  tarball: string;
  sha256: string;
  minCoreVersion?: string;
  permissions?: ModulePermissions;
  docs?: string;
}

export interface StagedModule {
  name: string;
  version: string;
  // Temp directory holding the verified, extracted module. Never executed
  // from; commitModule copies it into the live modules root.
  dir: string;
  manifest: Record<string, unknown>;
  permissions: ModulePermissions;
}

export class InstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstallError';
  }
}

// ---------------------------------------------------------------------------
// Registry index
// ---------------------------------------------------------------------------

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function parsePermissions(v: unknown): ModulePermissions {
  if (!v || typeof v !== 'object') return {};
  const o = v as Record<string, unknown>;
  const out: ModulePermissions = {};
  if (isStringArray(o['network'])) out.network = o['network'];
  if (isStringArray(o['subprocess'])) out.subprocess = o['subprocess'];
  if (isStringArray(o['filesystem'])) out.filesystem = o['filesystem'];
  return out;
}

// Validate one index entry. Throwing per-entry (rather than skipping quietly)
// is deliberate for a curated index: a malformed entry is a publishing bug
// that should be loud, not a module that silently vanishes from the store.
export function parseRegistryEntry(raw: unknown): RegistryIndexEntry {
  if (!raw || typeof raw !== 'object') throw new InstallError('registry entry is not an object');
  const o = raw as Record<string, unknown>;
  const name = String(o['name'] ?? '');
  if (!MODULE_NAME_RE.test(name))
    throw new InstallError(`bad module name: ${JSON.stringify(name)}`);
  const version = String(o['version'] ?? '');
  if (!VERSION_RE.test(version))
    throw new InstallError(`bad version for ${name}: ${JSON.stringify(version)}`);
  const tarball = String(o['tarball'] ?? '');
  if (!tarball.startsWith('https://'))
    throw new InstallError(`tarball URL for ${name} must be https:// (got ${tarball || 'empty'})`);
  const sha256 = String(o['sha256'] ?? '').toLowerCase();
  if (!SHA256_RE.test(sha256)) throw new InstallError(`bad sha256 for ${name}`);
  const entry: RegistryIndexEntry = {
    name,
    version,
    tarball,
    sha256,
    permissions: parsePermissions(o['permissions']),
  };
  if (typeof o['displayName'] === 'string') entry.displayName = o['displayName'];
  if (typeof o['description'] === 'string') entry.description = o['description'];
  if (typeof o['docs'] === 'string') entry.docs = o['docs'];
  if (typeof o['minCoreVersion'] === 'string') {
    if (!VERSION_RE.test(o['minCoreVersion']))
      throw new InstallError(`bad minCoreVersion for ${name}`);
    entry.minCoreVersion = o['minCoreVersion'];
  }
  return entry;
}

export function parseRegistryIndex(json: unknown): RegistryIndexEntry[] {
  const list = Array.isArray(json)
    ? json
    : json && typeof json === 'object' && Array.isArray((json as { modules?: unknown }).modules)
      ? (json as { modules: unknown[] }).modules
      : null;
  if (!list) throw new InstallError('registry index must be an array or {"modules": [...]}');
  return list.map(parseRegistryEntry);
}

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10));
  const pb = b.split('.').map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Download + verify
// ---------------------------------------------------------------------------

export type FetchLike = (url: string) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export async function downloadAndVerify(
  entry: RegistryIndexEntry,
  opts: { fetchImpl?: FetchLike; maxBytes?: number } = {},
): Promise<Buffer> {
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_TARBALL_BYTES;
  if (!entry.tarball.startsWith('https://')) throw new InstallError('tarball URL must be https://');
  const res = await fetchImpl(entry.tarball);
  if (!res.ok) throw new InstallError(`download failed: HTTP ${res.status}`);
  const declared = Number.parseInt(res.headers.get('content-length') ?? '', 10);
  if (!Number.isNaN(declared) && declared > maxBytes)
    throw new InstallError(`tarball exceeds the ${maxBytes}-byte cap`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > maxBytes) throw new InstallError(`tarball exceeds the ${maxBytes}-byte cap`);
  const digest = createHash('sha256').update(buf).digest('hex');
  if (digest !== entry.sha256)
    throw new InstallError(
      `sha256 mismatch for ${entry.name}: index pins ${entry.sha256.slice(0, 12)}…, got ${digest.slice(0, 12)}… — refusing to install`,
    );
  return buf;
}

// ---------------------------------------------------------------------------
// Strict ustar extraction
// ---------------------------------------------------------------------------

function parseOctal(field: Buffer): number {
  const s = field.toString('ascii').replace(/\0/g, '').trim();
  if (s === '') return 0;
  const n = Number.parseInt(s, 8);
  if (Number.isNaN(n) || n < 0) throw new InstallError('corrupt tar header (bad octal field)');
  return n;
}

function headerChecksumOk(header: Buffer): boolean {
  const stored = parseOctal(header.subarray(148, 156));
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i]!;
  return sum === stored;
}

// A safe relative path: no absolutes, no drive letters, no `..` segments, no
// backslashes. Resolved containment is asserted again at write time.
function assertSafeEntryPath(name: string): void {
  if (name.length === 0 || name.length > 512) throw new InstallError('tar entry path length');
  if (name.includes('\\')) throw new InstallError(`tar entry uses backslashes: ${name}`);
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name))
    throw new InstallError(`tar entry is absolute: ${name}`);
  for (const seg of name.split('/')) {
    if (seg === '..') throw new InstallError(`tar entry escapes its root: ${name}`);
  }
}

// Extract a .tgz (or raw tar) buffer into destDir. Returns the relative paths
// written. Throws on anything that isn't a plain file or directory.
export function extractTarGz(
  buf: Buffer,
  destDir: string,
  opts: { maxUnpackedBytes?: number } = {},
): string[] {
  const maxUnpacked = opts.maxUnpackedBytes ?? DEFAULT_MAX_UNPACKED_BYTES;
  const tar =
    buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b
      ? gunzipSync(buf, { maxOutputLength: maxUnpacked })
      : buf;
  if (tar.length % 512 !== 0) throw new InstallError('tar stream is not 512-byte aligned');

  const root = resolve(destDir);
  mkdirSync(root, { recursive: true });
  const written: string[] = [];
  let unpacked = 0;
  let off = 0;
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    off += 512;
    if (header.every((b) => b === 0)) break; // end-of-archive marker
    if (!headerChecksumOk(header)) throw new InstallError('corrupt tar header (checksum)');

    const nameField = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const name = prefix ? `${prefix}/${nameField}` : nameField;
    const size = parseOctal(header.subarray(124, 136));
    const type = String.fromCharCode(header[156]!);

    const dataBlocks = Math.ceil(size / 512) * 512;
    if (off + dataBlocks > tar.length) throw new InstallError('truncated tar entry');
    const data = tar.subarray(off, off + size);
    off += dataBlocks;

    // Strictness IS the security boundary: a module tarball has no business
    // containing symlinks, hardlinks, devices, or pax/gnu module records.
    // Reject the whole archive rather than skip — a "mostly fine" artifact
    // from a curated registry is a publishing bug or an attack, not a module.
    if (type !== '0' && type !== '\0' && type !== '5') {
      throw new InstallError(`tar entry type '${type}' is not allowed (${name || '<unnamed>'})`);
    }
    assertSafeEntryPath(name);
    const target = resolve(root, name);
    if (target !== root && !target.startsWith(root + sep))
      throw new InstallError(`tar entry resolves outside the destination: ${name}`);

    if (type === '5') {
      mkdirSync(target, { recursive: true });
    } else {
      unpacked += size;
      if (unpacked > maxUnpacked) throw new InstallError('tarball expands past the unpack cap');
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, data);
      written.push(name);
    }
  }
  return written;
}

// ---------------------------------------------------------------------------
// Stage → consent → commit
// ---------------------------------------------------------------------------

export interface StageOptions {
  // Where staging directories are created (a private temp under ~/.modulus).
  stagingRoot: string;
  // Core version for minCoreVersion gating.
  hostVersion: string;
  fetchImpl?: FetchLike;
  maxBytes?: number;
  log?: Logger;
}

export async function stageModule(
  entry: RegistryIndexEntry,
  opts: StageOptions,
): Promise<StagedModule> {
  if (entry.minCoreVersion && compareSemver(opts.hostVersion, entry.minCoreVersion) < 0) {
    throw new InstallError(
      `${entry.name} ${entry.version} needs Modulus >= ${entry.minCoreVersion} (this is ${opts.hostVersion}) — update Modulus first`,
    );
  }
  const buf = await downloadAndVerify(entry, {
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.maxBytes ? { maxBytes: opts.maxBytes } : {}),
  });
  mkdirSync(opts.stagingRoot, { recursive: true });
  const dir = mkdtempSync(join(opts.stagingRoot, `${entry.name}-`));
  try {
    extractTarGz(buf, dir);
    // The tarball may root the module at ./ or at ./<name>/ — accept both.
    const root = existsSync(join(dir, 'manifest.json'))
      ? dir
      : existsSync(join(dir, entry.name, 'manifest.json'))
        ? join(dir, entry.name)
        : null;
    if (!root) throw new InstallError(`tarball for ${entry.name} contains no manifest.json`);
    const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    const manifestName = String(manifest['name'] ?? '');
    // The manifest must claim exactly the identity the index promised —
    // otherwise a tarball for module A could overwrite installed module B.
    if (manifestName !== entry.name) {
      throw new InstallError(
        `manifest name '${manifestName}' does not match registry entry '${entry.name}'`,
      );
    }
    opts.log?.info('module staged', { name: entry.name, version: entry.version, dir: root });
    return {
      name: entry.name,
      version: entry.version,
      dir: root,
      manifest,
      permissions: entry.permissions ?? {},
    };
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

export function discardStage(staged: StagedModule): void {
  // The staged dir may be a subdir of the mkdtemp root (./<name>/ layout);
  // remove from the temp root either way.
  let root = staged.dir;
  const parent = dirname(root);
  if (parent !== root && /-[A-Za-z0-9]+$/.test(parent.split(sep).pop() ?? '')) root = parent;
  rmSync(root, { recursive: true, force: true });
}

// Copy the verified, consented module into the live modules root. `replace`
// is the update path; a fresh install refuses to overwrite so an installed
// module can't be clobbered by a name squat the consent screen never showed.
export function commitModule(
  staged: StagedModule,
  destRoot: string,
  opts: { replace?: boolean } = {},
): string {
  if (!MODULE_NAME_RE.test(staged.name)) throw new InstallError('unsafe module name');
  const root = resolve(destRoot);
  const dest = resolve(root, staged.name);
  if (dest !== root && !dest.startsWith(root + sep))
    throw new InstallError('destination escapes the modules root');
  if (existsSync(dest)) {
    if (!opts.replace) throw new InstallError(`${staged.name} is already installed`);
    rmSync(dest, { recursive: true, force: true });
  }
  mkdirSync(root, { recursive: true });
  cpSync(staged.dir, dest, { recursive: true });
  discardStage(staged);
  return dest;
}

// ---------------------------------------------------------------------------
// Consent helpers
// ---------------------------------------------------------------------------

// Permissions ADDED by `after` relative to `before`. Empty object = nothing
// new = an update may proceed under the existing consent; anything here must
// be re-consented ("no silent capability grants on update").
export function permissionDiff(
  before: ModulePermissions,
  after: ModulePermissions,
): ModulePermissions {
  const added = (a?: string[], b?: string[]): string[] =>
    (b ?? []).filter((x) => !(a ?? []).includes(x));
  const out: ModulePermissions = {};
  const network = added(before.network, after.network);
  const subprocess = added(before.subprocess, after.subprocess);
  const filesystem = added(before.filesystem, after.filesystem);
  if (network.length > 0) out.network = network;
  if (subprocess.length > 0) out.subprocess = subprocess;
  if (filesystem.length > 0) out.filesystem = filesystem;
  return out;
}

export function hasPermissions(p: ModulePermissions): boolean {
  return (p.network?.length ?? 0) + (p.subprocess?.length ?? 0) + (p.filesystem?.length ?? 0) > 0;
}

// Plain-language consent lines for the UI/CLI. Everyday people read these, so
// no jargon: say what the module can DO.
export function describePermissions(p: ModulePermissions): string[] {
  const lines: string[] = [];
  for (const d of p.network ?? []) lines.push(`Can contact ${d} on the internet`);
  for (const b of p.subprocess ?? []) lines.push(`Can run the program "${b}" on this computer`);
  for (const f of p.filesystem ?? []) lines.push(`Can read and write files under ${f}`);
  if (lines.length === 0) lines.push('Needs no special permissions');
  return lines;
}
