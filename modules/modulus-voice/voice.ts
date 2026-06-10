// Bundled default Piper voice. We don't ship the .onnx in git (too big and the
// licence belongs to rhasspy/piper-voices), but we do auto-fetch it the first
// time the user enables /voice — so the module is "pre-configured" from
// their perspective.
//
// Voice: en_GB-northern_english_male-medium. Male, British (Northern English),
// medium quality. ~63 MB resident; about 1× realtime synth on a Pi 5.

import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import type { Logger } from '../../src/util/log.js';

// Abort a download if no bytes arrive for this long. A stall timer (reset on
// every chunk) rather than a total deadline lets a large model download over a
// slow-but-progressing link finish, while a truly wedged connection — which
// would otherwise hang ensureVoiceModel forever, including inside afterReply —
// is cut loose.
const DOWNLOAD_STALL_MS = 60_000;

export interface VoiceSpec {
  id: string;
  modelUrl: string;
  configUrl: string;
}

export const DEFAULT_VOICE_ID = 'en_GB-northern_english_male-medium';

export const DEFAULT_VOICE: VoiceSpec = voiceSpecFor(DEFAULT_VOICE_ID);

// A curated short list of decent English Piper voices the setup wizard offers
// up front. Users can still type any valid Piper voice ID (e.g. `de_DE-thorsten-medium`)
// and we'll resolve the URL for it via voiceSpecFor().
export interface CuratedVoice {
  id: string;
  label: string;
}

export const CURATED_VOICES: ReadonlyArray<CuratedVoice> = [
  { id: 'en_GB-northern_english_male-medium', label: 'Northern English male — default' },
  { id: 'en_GB-alan-medium', label: 'British male (Alan)' },
  { id: 'en_GB-jenny_dioco-medium', label: 'British female (Jenny)' },
  { id: 'en_US-amy-medium', label: 'American female (Amy)' },
  { id: 'en_US-ryan-high', label: 'American male (Ryan, high quality)' },
  { id: 'en_US-lessac-medium', label: 'American female (Lessac)' },
];

// Build a Piper voice URL from a voice ID like `en_GB-alan-medium`.
// Format on huggingface: <lang>/<lang_country>/<voice_name>/<quality>/<id>.onnx
export function voiceSpecFor(id: string): VoiceSpec {
  const parts = id.split('-');
  if (parts.length !== 3) {
    throw new Error(
      `invalid Piper voice id '${id}' — expected '<lang_country>-<voice>-<quality>' (e.g. en_GB-alan-medium)`,
    );
  }
  const [langCountry, voice, quality] = parts as [string, string, string];
  const lang = langCountry.split('_')[0]!;
  const base = `https://huggingface.co/rhasspy/piper-voices/resolve/main/${lang}/${langCountry}/${voice}/${quality}/${id}.onnx`;
  return { id, modelUrl: base, configUrl: `${base}.json` };
}

// Dedup concurrent download attempts within a single process. Two near-
// simultaneous /voice replies would otherwise race on the same temp file.
const inflight = new Map<string, Promise<string>>();

export async function ensureVoiceModel(
  dir: string,
  log: Logger,
  spec: VoiceSpec = DEFAULT_VOICE,
): Promise<string> {
  const modelPath = join(dir, `${spec.id}.onnx`);
  const configPath = `${modelPath}.json`;
  if (existsSync(modelPath) && existsSync(configPath)) return modelPath;

  const existing = inflight.get(modelPath);
  if (existing) return existing;

  const work = (async () => {
    mkdirSync(dir, { recursive: true });
    log.info('downloading default piper voice (one-shot)', {
      voice: spec.id,
      dir,
    });
    await download(spec.modelUrl, modelPath, log);
    await download(spec.configUrl, configPath, log);
    log.info('piper voice ready', { voice: spec.id });
    return modelPath;
  })();
  inflight.set(modelPath, work);
  try {
    return await work;
  } finally {
    inflight.delete(modelPath);
  }
}

async function download(url: string, destPath: string, log: Logger): Promise<void> {
  const tmp = `${destPath}.part`;
  const ctl = new AbortController();
  let stall: ReturnType<typeof setTimeout> | undefined;
  const resetStall = (): void => {
    if (stall) clearTimeout(stall);
    stall = setTimeout(() => ctl.abort(new Error('download stalled')), DOWNLOAD_STALL_MS);
    stall.unref?.();
  };
  resetStall();
  try {
    const res = await fetch(url, { redirect: 'follow', signal: ctl.signal });
    if (!res.ok || !res.body) {
      throw new Error(`download failed: ${url} → HTTP ${res.status}`);
    }
    const monitor = new Transform({
      transform(chunk, _enc, cb): void {
        resetStall();
        cb(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(res.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>),
      monitor,
      createWriteStream(tmp),
      { signal: ctl.signal },
    );
    renameSync(tmp, destPath);
  } catch (e) {
    rmSync(tmp, { force: true });
    log.warn('voice file download failed', {
      url,
      error: e instanceof Error ? e.message : String(e),
    });
    throw e;
  } finally {
    if (stall) clearTimeout(stall);
  }
}
