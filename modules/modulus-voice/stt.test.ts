import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { writeFileSync, existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  transcribe,
  transcribePcm,
  buildWavHeader,
  cleanTranscript,
  SttError,
  type RunShell,
} from './stt.js';

interface Recorded {
  cmd: string;
  args: string[];
}

function makeShell(
  responses: Array<{ code: number; stderr?: string; writeWav?: boolean; writeTxtTo?: string }>,
): { impl: RunShell; calls: Recorded[] } {
  const calls: Recorded[] = [];
  let i = 0;
  const impl: RunShell = async (cmd, args) => {
    calls.push({ cmd, args });
    const r = responses[i++];
    if (!r) throw new Error('shell script exhausted');
    if (r.writeWav) {
      // ffmpeg writes its WAV to the trailing positional arg.
      writeFileSync(args[args.length - 1]!, Buffer.from('RIFF'));
    }
    if (r.writeTxtTo) {
      // whisper writes `<wav>.txt` next to the input; copy the desired body
      // into that path so transcribe() can read it back.
      const fIdx = args.indexOf('-f');
      const wav = args[fIdx + 1]!;
      writeFileSync(`${wav}.txt`, r.writeTxtTo);
    }
    return {
      stdout: Buffer.alloc(0),
      stderr: r.stderr ?? '',
      code: r.code,
    };
  };
  return { impl, calls };
}

test('transcribe pipes ogg through ffmpeg then whisper, returns trimmed transcript', async () => {
  const { impl, calls } = makeShell([
    // ffmpeg: writes the wav (positional output is the last arg)
    { code: 0, writeWav: true },
    // whisper: writes the .txt next to the input wav
    { code: 0, writeTxtTo: '  hello world  \n[BLANK_AUDIO]\n' },
  ]);

  const tmp = mkdtempSync(join(tmpdir(), 'modulus-voice-stt-test-'));
  const oggPath = join(tmp, 'in.ogg');
  writeFileSync(oggPath, Buffer.from('OggS'));

  try {
    const result = await transcribe(
      {
        oggPath,
        whisperBin: 'whisper-cli',
        ffmpegBin: 'ffmpeg',
        modelPath: '/models/ggml-base.en.bin',
        language: 'en',
      },
      impl,
    );

    assert.equal(result.transcript, 'hello world');
    assert.equal(calls.length, 2);

    // ffmpeg argv: must request 16 kHz mono PCM s16le WAV.
    assert.equal(calls[0]!.cmd, 'ffmpeg');
    assert.ok(calls[0]!.args.includes('-ar'));
    assert.ok(calls[0]!.args.includes('16000'));
    assert.ok(calls[0]!.args.includes('-ac'));
    assert.ok(calls[0]!.args.includes('1'));
    assert.ok(calls[0]!.args.includes('pcm_s16le'));

    // whisper argv: model path, the produced wav, language, txt output, no timestamps.
    assert.equal(calls[1]!.cmd, 'whisper-cli');
    assert.deepEqual(calls[1]!.args.slice(0, 2), ['-m', '/models/ggml-base.en.bin']);
    assert.ok(calls[1]!.args.includes('-otxt'));
    assert.ok(calls[1]!.args.includes('-nt'));
    assert.equal(calls[1]!.args[calls[1]!.args.indexOf('-l') + 1], 'en');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('transcribe cleans up its temp dir even when whisper fails', async () => {
  const { impl } = makeShell([
    { code: 0, writeWav: true },
    { code: 1, stderr: 'no model' },
  ]);

  const tmp = mkdtempSync(join(tmpdir(), 'modulus-voice-stt-test-'));
  const oggPath = join(tmp, 'in.ogg');
  writeFileSync(oggPath, Buffer.from('OggS'));

  try {
    let leakedDir: string | null = null;
    const wrap: RunShell = async (cmd, args, opts) => {
      // Steal the wav path on the ffmpeg call so we can verify cleanup ran.
      if (cmd === 'ffmpeg') leakedDir = args[args.length - 1]!;
      return impl(cmd, args, opts);
    };

    await assert.rejects(
      () =>
        transcribe(
          {
            oggPath,
            whisperBin: 'whisper-cli',
            ffmpegBin: 'ffmpeg',
            modelPath: '/m.bin',
          },
          wrap,
        ),
      (e: unknown) => e instanceof SttError && e.stage === 'whisper',
    );

    // The wav was inside a temp dir we created; that dir should be gone.
    assert.ok(leakedDir, 'ffmpeg should have been invoked');
    assert.equal(existsSync(leakedDir!), false, 'temp dir survives — cleanup missed it');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('transcribe errors when whisper produces no output file', async () => {
  const { impl } = makeShell([{ code: 0, writeWav: true }, { code: 0 }]);
  const tmp = mkdtempSync(join(tmpdir(), 'modulus-voice-stt-test-'));
  const oggPath = join(tmp, 'in.ogg');
  writeFileSync(oggPath, Buffer.from('OggS'));

  try {
    await assert.rejects(
      () =>
        transcribe(
          {
            oggPath,
            whisperBin: 'whisper-cli',
            ffmpegBin: 'ffmpeg',
            modelPath: '/m.bin',
          },
          impl,
        ),
      (e: unknown) => e instanceof SttError && e.stage === 'output',
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('buildWavHeader produces a valid 16-bit mono PCM RIFF header', () => {
  const pcmLen = 320; // 10 ms at 16 kHz mono 16-bit
  const h = buildWavHeader(pcmLen, 16000);
  assert.equal(h.length, 44);
  assert.equal(h.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(h.readUInt32LE(4), 36 + pcmLen);
  assert.equal(h.subarray(8, 12).toString('ascii'), 'WAVE');
  assert.equal(h.subarray(12, 16).toString('ascii'), 'fmt ');
  assert.equal(h.readUInt32LE(16), 16); // PCM fmt chunk size
  assert.equal(h.readUInt16LE(20), 1); // PCM format
  assert.equal(h.readUInt16LE(22), 1); // mono
  assert.equal(h.readUInt32LE(24), 16000); // sample rate
  assert.equal(h.readUInt32LE(28), 16000 * 2); // byte rate
  assert.equal(h.readUInt16LE(32), 2); // block align
  assert.equal(h.readUInt16LE(34), 16); // bits per sample
  assert.equal(h.subarray(36, 40).toString('ascii'), 'data');
  assert.equal(h.readUInt32LE(40), pcmLen);
});

test('transcribePcm writes WAV header + PCM, skips ffmpeg, runs whisper', async () => {
  // Single shell call expected (whisper). ffmpeg is bypassed.
  const calls: Array<{ cmd: string; args: string[] }> = [];
  let wavOnDisk: Buffer | null = null;
  const impl: RunShell = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'whisper-cli') {
      // The wav passed to -f must already exist with the right header.
      const fIdx = args.indexOf('-f');
      const wavPath = args[fIdx + 1]!;
      wavOnDisk = readFileSync(wavPath);
      writeFileSync(`${wavPath}.txt`, 'pcm hello\n');
    }
    return { stdout: Buffer.alloc(0), stderr: '', code: 0 };
  };

  // 100 ms of "PCM": 1600 samples * 2 bytes = 3200 bytes of zeroes is fine for
  // the wiring check.
  const pcm = Buffer.alloc(3200);
  const result = await transcribePcm(
    { pcm, sampleRate: 16000, whisperBin: 'whisper-cli', modelPath: '/m.bin', language: 'en' },
    impl,
  );

  assert.equal(result.transcript, 'pcm hello');
  assert.equal(calls.length, 1, 'ffmpeg must not be invoked for raw PCM');
  assert.equal(calls[0]!.cmd, 'whisper-cli');
  assert.ok(calls[0]!.args.includes('-otxt'));
  assert.equal(calls[0]!.args[calls[0]!.args.indexOf('-l') + 1], 'en');

  // The wav whisper saw should be header (44) + payload (3200).
  assert.ok(wavOnDisk, 'whisper should have been pointed at a real wav file');
  assert.equal(wavOnDisk!.length, 44 + 3200);
  assert.equal(wavOnDisk!.subarray(0, 4).toString('ascii'), 'RIFF');
});

test('transcribePcm rejects non-16k sample rates', async () => {
  await assert.rejects(
    () =>
      transcribePcm(
        { pcm: Buffer.alloc(16), sampleRate: 48000, whisperBin: 'w', modelPath: '/m.bin' },
        async () => ({ stdout: Buffer.alloc(0), stderr: '', code: 0 }),
      ),
    (e: unknown) => e instanceof SttError && /16000/.test(e.message),
  );
});

test('transcribePcm cleans up its temp dir on whisper failure', async () => {
  let wavPath: string | null = null;
  const impl: RunShell = async (cmd, args) => {
    if (cmd === 'whisper-cli') {
      wavPath = args[args.indexOf('-f') + 1]!;
      return { stdout: Buffer.alloc(0), stderr: 'boom', code: 1 };
    }
    return { stdout: Buffer.alloc(0), stderr: '', code: 0 };
  };
  await assert.rejects(
    () =>
      transcribePcm(
        {
          pcm: Buffer.alloc(16),
          sampleRate: 16000,
          whisperBin: 'whisper-cli',
          modelPath: '/m.bin',
        },
        impl,
      ),
    (e: unknown) => e instanceof SttError && e.stage === 'whisper',
  );
  assert.ok(wavPath, 'whisper should have been invoked');
  assert.equal(existsSync(wavPath!), false, 'temp dir survived — cleanup missed it');
});

test('cleanTranscript strips whisper sentinels and normalises whitespace', () => {
  assert.equal(cleanTranscript('  hello   world  '), 'hello world');
  assert.equal(cleanTranscript('  hi [BLANK_AUDIO] there '), 'hi there');
  assert.equal(cleanTranscript('foo\n\n[Music]\nbar'), 'foo bar');
  // The dummy readFileSync use just keeps the import alive for tools that
  // would otherwise drop unused imports during lint.
  void readFileSync;
});
