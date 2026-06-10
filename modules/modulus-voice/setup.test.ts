import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectFfmpegInstaller,
  ensureFfmpegForTts,
  ensurePiperForTts,
  ensureVoiceModelForTts,
  type InstallStep,
} from './setup.js';

test('detectFfmpegInstaller chooses apt-get with sudo for non-root Linux installs', () => {
  const available = new Set(['apt-get', 'sudo']);
  const plan = detectFfmpegInstaller({
    platform: 'linux',
    getuid: () => 1000,
    commandExists: (cmd) => available.has(cmd),
  });

  assert.equal(plan?.name, 'apt-get');
  assert.deepEqual(plan?.steps, [
    { command: 'sudo', args: ['apt-get', 'update'] },
    { command: 'sudo', args: ['apt-get', 'install', '-y', 'ffmpeg'] },
  ]);
});

test('detectFfmpegInstaller chooses winget on Windows', () => {
  const plan = detectFfmpegInstaller({
    platform: 'win32',
    commandExists: (cmd) => cmd === 'winget',
  });

  assert.equal(plan?.name, 'winget');
  assert.equal(plan?.steps[0]?.command, 'winget');
  assert.ok(plan?.steps[0]?.args.includes('Gyan.FFmpeg'));
});

test('ensureFfmpegForTts skips install when ffmpeg is already available', async () => {
  const output: string[] = [];
  const ran: InstallStep[] = [];
  const found = await ensureFfmpegForTts({
    commandExists: (cmd) => cmd === 'ffmpeg',
    commandPath: (cmd) => (cmd === 'ffmpeg' ? '/usr/bin/ffmpeg' : undefined),
    runStep: (step) => {
      ran.push(step);
      return 0;
    },
    confirm: async () => {
      throw new Error('confirm should not run');
    },
    stdout: (text) => output.push(text),
  });

  assert.equal(ran.length, 0);
  assert.equal(found, '/usr/bin/ffmpeg');
  assert.match(output.join(''), /\/usr\/bin\/ffmpeg/);
});

test('ensureFfmpegForTts installs ffmpeg with the detected package manager', async () => {
  const available = new Set(['apt-get']);
  const ran: InstallStep[] = [];
  const output: string[] = [];

  const found = await ensureFfmpegForTts({
    platform: 'linux',
    getuid: () => 0,
    commandExists: (cmd) => available.has(cmd),
    commandPath: (cmd) => (cmd === 'ffmpeg' && available.has(cmd) ? '/usr/bin/ffmpeg' : undefined),
    confirm: async (_message, defaultValue) => defaultValue,
    runStep: (step) => {
      ran.push(step);
      if (step.command === 'apt-get' && step.args.includes('install')) available.add('ffmpeg');
      return 0;
    },
    stdout: (text) => output.push(text),
  });

  assert.deepEqual(ran, [
    { command: 'apt-get', args: ['update'] },
    { command: 'apt-get', args: ['install', '-y', 'ffmpeg'] },
  ]);
  assert.equal(found, '/usr/bin/ffmpeg');
  assert.match(output.join(''), /\/usr\/bin\/ffmpeg/);
});

test('ensureFfmpegForTts prints manual instructions when no installer is available', async () => {
  const output: string[] = [];
  const found = await ensureFfmpegForTts({
    commandExists: () => false,
    confirm: async () => {
      throw new Error('confirm should not run');
    },
    stdout: (text) => output.push(text),
  });

  assert.equal(found, undefined);
  assert.match(output.join(''), /Install ffmpeg manually/);
});

test('ensurePiperForTts downloads Piper into module state and returns its path', async () => {
  const home = mkdtempSync(join(tmpdir(), 'modulus-piper-native-'));
  try {
    const downloads: string[] = [];
    const out: string[] = [];
    const piper = await ensurePiperForTts({
      home,
      platform: 'linux',
      arch: 'x64',
      commandExists: () => false,
      downloadFile: async (url, destPath) => {
        downloads.push(url);
        writeFileSync(destPath, 'archive');
      },
      extractArchive: async (_archivePath, destDir) => {
        const piperDir = join(destDir, 'piper');
        mkdirSync(piperDir, { recursive: true });
        writeFileSync(join(piperDir, 'piper'), 'binary');
        return 0;
      },
      stdout: (text) => out.push(text),
    });

    assert.ok(piper?.endsWith(join('piper', 'piper')));
    assert.match(downloads[0]!, /piper_linux_x86_64\.tar\.gz$/);
    assert.match(out.join(''), /Piper installed/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('ensurePiperForTts returns an existing managed Piper binary without downloading', async () => {
  const home = mkdtempSync(join(tmpdir(), 'modulus-piper-native-'));
  try {
    const piperDir = join(
      home,
      'module_state',
      'modulus-voice',
      'native',
      'piper-2023.11.14-2',
      'piper',
    );
    mkdirSync(piperDir, { recursive: true });
    const existing = join(piperDir, 'piper');
    writeFileSync(existing, 'binary');

    const piper = await ensurePiperForTts({
      home,
      platform: 'linux',
      arch: 'x64',
      commandExists: () => false,
      downloadFile: async () => {
        throw new Error('download should not run');
      },
      stdout: () => {},
    });

    assert.equal(piper, existing);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('ensureVoiceModelForTts downloads the model and config into module state', async () => {
  const home = mkdtempSync(join(tmpdir(), 'modulus-voice-native-'));
  try {
    const downloads: string[] = [];
    const out: string[] = [];
    const model = await ensureVoiceModelForTts({
      home,
      voiceId: 'en_GB-alan-medium',
      downloadFile: async (url, destPath) => {
        downloads.push(url);
        writeFileSync(destPath, 'voice');
      },
      stdout: (text) => out.push(text),
    });

    assert.ok(model?.endsWith(join('voices', 'en_GB-alan-medium.onnx')));
    assert.match(downloads[0]!, /en_GB-alan-medium\.onnx$/);
    assert.match(downloads[1]!, /en_GB-alan-medium\.onnx\.json$/);
    assert.match(out.join(''), /Voice model installed/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('ensureVoiceModelForTts returns an existing downloaded voice model', async () => {
  const home = mkdtempSync(join(tmpdir(), 'modulus-voice-native-'));
  try {
    const voices = join(home, 'module_state', 'modulus-voice', 'voices');
    mkdirSync(voices, { recursive: true });
    const model = join(voices, 'en_GB-alan-medium.onnx');
    writeFileSync(model, 'model');
    writeFileSync(`${model}.json`, 'config');

    const found = await ensureVoiceModelForTts({
      home,
      voiceId: 'en_GB-alan-medium',
      downloadFile: async () => {
        throw new Error('download should not run');
      },
      stdout: () => {},
    });

    assert.equal(found, model);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
