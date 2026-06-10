// Whisper.cpp transcription pipeline. Pure shell glue:
//   ogg/opus → ffmpeg → 16 kHz mono wav → whisper-cli → txt
//
// Telegram voice notes are OGG/Opus at 48 kHz; whisper.cpp expects 16-bit PCM
// WAV at 16 kHz mono. ffmpeg is already a dep of the TTS pipeline so we reuse
// it here without bloating the install surface.
//
// Like synth.ts, the pipeline is pluggable via `runShell`: tests pass a stub
// so the wiring can be exercised without whisper-cli installed.

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectChildOutput } from './shell.js';

export interface TranscribeRequest {
  // Path to the incoming voice note (OGG/Opus) on disk.
  oggPath: string;
  whisperBin: string;
  ffmpegBin: string;
  // Path to the ggml whisper model (.bin). Auto-downloaded by setup.ts.
  modelPath: string;
  // ISO-639-1 language code, or "auto" to let whisper detect. Defaults to
  // "auto" when unset.
  language?: string;
}

export interface TranscribePcmRequest {
  // Raw 16-bit little-endian PCM samples, single channel.
  pcm: Buffer;
  // Sample rate of `pcm`. Anything other than 16000 is rejected — whisper.cpp
  // is fussy and the speaker firmware already streams 16 kHz, so we don't
  // bother resampling here.
  sampleRate: number;
  whisperBin: string;
  modelPath: string;
  language?: string;
}

export interface TranscribeResult {
  transcript: string;
}

export type RunShell = (
  cmd: string,
  args: string[],
  opts: { cwd?: string },
) => Promise<{ stdout: Buffer; stderr: string; code: number }>;

export class SttError extends Error {
  constructor(
    public stage: 'ffmpeg' | 'whisper' | 'output',
    public code: number,
    message: string,
  ) {
    super(message);
    this.name = 'SttError';
  }
}

export const defaultRunShell: RunShell = (cmd, args, { cwd }) => {
  const child = spawn(cmd, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(cwd ? { cwd } : {}),
  });
  return collectChildOutput(child, cmd, { collectStdout: true });
};

// Normalise whisper's text output. The model occasionally emits leading
// whitespace, repeated punctuation, and `[BLANK_AUDIO]`-style markers for
// silent stretches. Strip those so the transcript reads like a real message.
export function cleanTranscript(raw: string): string {
  return raw
    .replace(/\[(BLANK_AUDIO|MUSIC|NOISE|SILENCE|.*?_PLAYING)\]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function runWhisperOnWav(
  wavPath: string,
  req: { whisperBin: string; modelPath: string; language?: string },
  runShell: RunShell,
): Promise<TranscribeResult> {
  const txtPath = `${wavPath}.txt`;
  const lang = req.language?.trim() || 'auto';
  const whisperRes = await runShell(
    req.whisperBin,
    ['-m', req.modelPath, '-f', wavPath, '-l', lang, '-otxt', '-nt'],
    {},
  );
  if (whisperRes.code !== 0) {
    throw new SttError('whisper', whisperRes.code, whisperRes.stderr || 'whisper failed');
  }
  if (!existsSync(txtPath)) {
    throw new SttError('output', -1, `whisper produced no output at ${txtPath}`);
  }
  return { transcript: cleanTranscript(readFileSync(txtPath, 'utf8')) };
}

export async function transcribe(
  req: TranscribeRequest,
  runShell: RunShell = defaultRunShell,
): Promise<TranscribeResult> {
  const dir = mkdtempSync(join(tmpdir(), 'modulus-voice-stt-'));
  const wavPath = join(dir, 'in.wav');

  try {
    // OGG/Opus → 16 kHz mono 16-bit PCM WAV. Whisper.cpp's input contract is
    // strict; -ar/-ac/-acodec must match or it'll emit garbage.
    const ffmpegRes = await runShell(
      req.ffmpegBin,
      [
        '-y',
        '-i',
        req.oggPath,
        '-ar',
        '16000',
        '-ac',
        '1',
        '-c:a',
        'pcm_s16le',
        '-f',
        'wav',
        wavPath,
      ],
      {},
    );
    if (ffmpegRes.code !== 0) {
      throw new SttError('ffmpeg', ffmpegRes.code, ffmpegRes.stderr || 'ffmpeg failed');
    }

    return await runWhisperOnWav(wavPath, req, runShell);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Build a 16-bit mono PCM WAV file header for `pcmByteLength` bytes of payload.
// Whisper.cpp parses the RIFF header strictly: wrong sample rate, channel
// count, or bits-per-sample produces silence-shaped garbage rather than an
// error. Centralised here so the test can assert it byte-for-byte.
export function buildWavHeader(pcmByteLength: number, sampleRate: number): Buffer {
  const channels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);

  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcmByteLength, 4); // file size - 8
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcmByteLength, 40);
  return header;
}

// Transcribe raw 16-bit PCM samples (single channel, 16 kHz) without going
// through ffmpeg. Used by modulus-speaker, which already has the audio in
// whisper-ready shape coming off the WebSocket.
export async function transcribePcm(
  req: TranscribePcmRequest,
  runShell: RunShell = defaultRunShell,
): Promise<TranscribeResult> {
  if (req.sampleRate !== 16000) {
    throw new SttError(
      'output',
      -1,
      `transcribePcm requires 16000 Hz input (got ${req.sampleRate})`,
    );
  }
  const dir = mkdtempSync(join(tmpdir(), 'modulus-voice-stt-pcm-'));
  const wavPath = join(dir, 'in.wav');

  try {
    const header = buildWavHeader(req.pcm.length, req.sampleRate);
    writeFileSync(wavPath, Buffer.concat([header, req.pcm]));
    return await runWhisperOnWav(wavPath, req, runShell);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
