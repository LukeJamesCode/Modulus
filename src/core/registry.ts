// Registry client: fetch and parse the module marketplace index.
//
// The index is a single JSON document (an array, or {"modules": [...]}) of
// RegistryIndexEntry — each pinning a module's https tarball + sha256. This
// module only FETCHES and PARSES it; downloading, verifying, staging, consent,
// and committing are installer.ts's job. The two-step split keeps the consent
// gate (installer.stageModule -> caller approves -> installer.commitModule)
// honest: nothing here can install anything.
//
// Default URL points at the curated modulus-registry repo's raw index; a
// self-hosted fork overrides it with MODULUS_REGISTRY_URL. The .tgz model here
// supersedes the older git-clone registry resolver in cli/ext.ts.

import {
  parseRegistryIndex,
  InstallError,
  type RegistryIndexEntry,
  type FetchLike,
} from './installer.js';

// Raw index.json of the curated registry. Self-hosted forks override via
// MODULUS_REGISTRY_URL. Kept as the raw.githubusercontent URL so a browse
// works with no auth and no API rate limit.
export const DEFAULT_REGISTRY_URL =
  'https://raw.githubusercontent.com/LukeJamesCode/modulus-registry/main/index.json';

// The index is small text (entries are metadata, not payloads); cap the body so
// a hostile or misconfigured URL can't stream gigabytes into memory.
const MAX_INDEX_BYTES = 5 * 1024 * 1024;

export function registryUrl(): string {
  return process.env['MODULUS_REGISTRY_URL']?.trim() || DEFAULT_REGISTRY_URL;
}

export interface FetchRegistryOptions {
  // Injectable for tests / offline; defaults to global fetch.
  fetchImpl?: FetchLike;
  // Override the index URL (defaults to registryUrl()).
  url?: string;
  maxBytes?: number;
}

// Fetch the index and return validated entries. Throws InstallError on a
// transport error, an oversized body, invalid JSON, or a malformed entry —
// parseRegistryIndex is strict on purpose (a bad entry in a curated index is a
// publishing bug, not a module to silently drop).
export async function fetchRegistryIndex(
  opts: FetchRegistryOptions = {},
): Promise<RegistryIndexEntry[]> {
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const url = opts.url ?? registryUrl();
  const maxBytes = opts.maxBytes ?? MAX_INDEX_BYTES;

  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchImpl(url);
  } catch (e) {
    throw new InstallError(`registry unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) throw new InstallError(`registry fetch failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > maxBytes) throw new InstallError('registry index exceeds the size cap');
  let json: unknown;
  try {
    json = JSON.parse(buf.toString('utf8'));
  } catch {
    throw new InstallError('registry index is not valid JSON');
  }
  return parseRegistryIndex(json);
}

// Resolve one entry by exact module name, or null if absent.
export function findRegistryEntry(
  entries: readonly RegistryIndexEntry[],
  name: string,
): RegistryIndexEntry | null {
  return entries.find((e) => e.name === name) ?? null;
}
