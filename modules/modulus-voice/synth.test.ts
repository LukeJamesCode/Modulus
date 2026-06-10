import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { writeFileSync, existsSync } from 'node:fs';
import { synthesize, TtsSynthError, type RunShell } from './synth.js';

interface Recorded {
  cmd: string;
  args: string[];
  input?: Buffer;
}

function makeShell(responses: Array<{ code: number; stderr?: string; touchOutput?: boolean }>): {
  impl: RunShell;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  let i = 0;
  const impl: RunShell = async (cmd, args, opts) => {
    const rec: Recorded = { cmd, args };
    if (opts.input) rec.input = opts.input;
    calls.push(rec);
    const r = responses[i++];
    if (!r) throw new Error('shell script exhausted');
    if (r.touchOutput) {
      // piper writes to --output_file; mimic by touching the path.
      const idx = args.indexOf('--output_file');
      if (idx !== -1) writeFileSync(args[idx + 1]!, Buffer.from('RIFF'));
    } else {
      // ffmpeg's output is a positional arg; touch the last one.
      writeFileSync(args[args.length - 1]!, Buffer.from('OggS'));
    }
    return { stdout: Buffer.alloc(0), stderr: r.stderr ?? '', code: r.code };
  };
  return { impl, calls };
}

test('synth pipes text into piper and ffmpeg, returns an ogg path', async () => {
  const { impl, calls } = makeShell([{ code: 0, touchOutput: true }, { code: 0 }]);
  const result = await synthesize(
    {
      text: 'hello world',
      piperBin: 'piper',
      ffmpegBin: 'ffmpeg',
      voiceModelPath: '/models/voice.onnx',
    },
    impl,
  );
  try {
    assert.ok(existsSync(result.oggPath), 'ogg file should exist');
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.cmd, 'piper');
    assert.deepEqual(calls[0]!.args.slice(0, 2), ['--model', '/models/voice.onnx']);
    assert.equal(calls[0]!.input?.toString('utf8'), 'hello world');
    assert.equal(calls[1]!.cmd, 'ffmpeg');
    assert.ok(calls[1]!.args.includes('libopus'), 'ffmpeg invoked with libopus');
  } finally {
    result.cleanup();
    assert.ok(!existsSync(result.oggPath), 'cleanup removes the temp dir');
  }
});

test('synth throws TtsSynthError when piper exits non-zero', async () => {
  const { impl } = makeShell([{ code: 1, stderr: 'no model' }]);
  await assert.rejects(
    () =>
      synthesize(
        {
          text: 'hi',
          piperBin: 'piper',
          ffmpegBin: 'ffmpeg',
          voiceModelPath: '/missing.onnx',
        },
        impl,
      ),
    (e: unknown) => e instanceof TtsSynthError && e.stage === 'piper',
  );
});

test('synth throws TtsSynthError when ffmpeg exits non-zero', async () => {
  const { impl } = makeShell([
    { code: 0, touchOutput: true },
    { code: 1, stderr: 'opus not built' },
  ]);
  await assert.rejects(
    () =>
      synthesize(
        {
          text: 'hi',
          piperBin: 'piper',
          ffmpegBin: 'ffmpeg',
          voiceModelPath: '/models/v.onnx',
        },
        impl,
      ),
    (e: unknown) => e instanceof TtsSynthError && e.stage === 'ffmpeg',
  );
});
