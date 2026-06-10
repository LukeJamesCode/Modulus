import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ModuleSetupContext } from '../../src/core/modules.js';

export interface InstallStep {
  command: string;
  args: string[];
}

export interface InstallerPlan {
  name: string;
  steps: InstallStep[];
}

export interface NativeDepsOptions {
  binary?: string;
  voiceId?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  home?: string;
  getuid?: () => number | undefined;
  commandExists?: (command: string) => boolean;
  commandPath?: (command: string) => string | undefined;
  runStep?: (step: InstallStep) => number | null;
  downloadFile?: (url: string, destPath: string) => Promise<void>;
  extractArchive?: (archivePath: string, destDir: string) => Promise<number | null>;
  confirm?: (message: string, defaultValue: boolean) => Promise<boolean>;
  stdout?: (text: string) => void;
}

const PIPER_VERSION = '2023.11.14-2';
const PIPER_RELEASE_BASE = `https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}`;
const DEFAULT_VOICE_ID = 'en_GB-northern_english_male-medium';

function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function isPathLike(command: string): boolean {
  return command.includes('/') || command.includes('\\');
}

export function defaultCommandExists(command: string): boolean {
  const probe = isPathLike(command)
    ? spawnSync(command, ['-version'], { stdio: 'ignore' })
    : process.platform === 'win32'
      ? spawnSync('where', [command], { stdio: 'ignore', shell: true })
      : spawnSync('sh', ['-c', `command -v ${shQuote(command)}`], { stdio: 'ignore' });
  return probe.status === 0;
}

export function defaultCommandPath(command: string): string | undefined {
  if (isPathLike(command)) return existsSync(command) ? command : undefined;
  const probe =
    process.platform === 'win32'
      ? spawnSync('where', [command], { encoding: 'utf8', shell: true })
      : spawnSync('sh', ['-c', `command -v ${shQuote(command)}`], { encoding: 'utf8' });
  if (probe.status !== 0 || !probe.stdout) return undefined;
  const first = probe.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find(Boolean);
  return first;
}

function defaultRunStep(step: InstallStep): number | null {
  const result = spawnSync(step.command, step.args, { stdio: 'inherit' });
  return result.status;
}

// Abort a download if no bytes arrive for this long. Reset-on-progress stall
// timer, not a total deadline, so a large but progressing model download still
// completes while a wedged connection can't hang setup forever.
const DOWNLOAD_STALL_MS = 60_000;

async function defaultDownloadFile(url: string, destPath: string): Promise<void> {
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
      throw new Error(`download failed: ${url} -> HTTP ${res.status}`);
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
      createWriteStream(destPath),
      { signal: ctl.signal },
    );
  } finally {
    if (stall) clearTimeout(stall);
  }
}

async function downloadWithPartFile(
  url: string,
  destPath: string,
  downloadFile: (url: string, destPath: string) => Promise<void>,
): Promise<void> {
  const tmp = `${destPath}.part`;
  try {
    await downloadFile(url, tmp);
    renameSync(tmp, destPath);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

function defaultExtractArchive(archivePath: string, destDir: string): number | null {
  if (archivePath.endsWith('.zip')) {
    const escapedArchive = archivePath.replace(/'/g, "''");
    const escapedDest = destDir.replace(/'/g, "''");
    const result = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Expand-Archive -LiteralPath '${escapedArchive}' -DestinationPath '${escapedDest}' -Force`,
      ],
      { stdio: 'inherit' },
    );
    return result.status;
  }
  const result = spawnSync('tar', ['-xzf', archivePath, '-C', destDir], { stdio: 'inherit' });
  return result.status;
}

function withPrivilege(
  command: string,
  args: string[],
  opts: Required<Pick<NativeDepsOptions, 'commandExists' | 'getuid'>>,
): InstallStep {
  const uid = opts.getuid();
  if (uid === 0 || !opts.commandExists('sudo')) return { command, args };
  return { command: 'sudo', args: [command, ...args] };
}

export function detectFfmpegInstaller(
  opts: Pick<NativeDepsOptions, 'platform' | 'commandExists' | 'getuid'> = {},
): InstallerPlan | null {
  const platform = opts.platform ?? process.platform;
  const commandExists = opts.commandExists ?? defaultCommandExists;
  const getuid = opts.getuid ?? (() => process.getuid?.());

  if (platform === 'win32') {
    if (commandExists('winget')) {
      return {
        name: 'winget',
        steps: [
          {
            command: 'winget',
            args: [
              'install',
              '--id',
              'Gyan.FFmpeg',
              '--exact',
              '--accept-package-agreements',
              '--accept-source-agreements',
            ],
          },
        ],
      };
    }
    if (commandExists('choco')) {
      return { name: 'choco', steps: [{ command: 'choco', args: ['install', 'ffmpeg', '-y'] }] };
    }
    if (commandExists('scoop')) {
      return { name: 'scoop', steps: [{ command: 'scoop', args: ['install', 'ffmpeg'] }] };
    }
    return null;
  }

  if (platform === 'darwin' && commandExists('brew')) {
    return { name: 'brew', steps: [{ command: 'brew', args: ['install', 'ffmpeg'] }] };
  }

  const priv = (command: string, args: string[]): InstallStep =>
    withPrivilege(command, args, { commandExists, getuid });

  if (commandExists('apt-get')) {
    return {
      name: 'apt-get',
      steps: [priv('apt-get', ['update']), priv('apt-get', ['install', '-y', 'ffmpeg'])],
    };
  }
  if (commandExists('dnf')) {
    return { name: 'dnf', steps: [priv('dnf', ['install', '-y', 'ffmpeg'])] };
  }
  if (commandExists('pacman')) {
    return { name: 'pacman', steps: [priv('pacman', ['-Sy', '--noconfirm', 'ffmpeg'])] };
  }
  if (commandExists('apk')) {
    return { name: 'apk', steps: [priv('apk', ['add', 'ffmpeg'])] };
  }
  if (commandExists('zypper')) {
    return { name: 'zypper', steps: [priv('zypper', ['install', '-y', 'ffmpeg'])] };
  }
  if (commandExists('brew')) {
    return { name: 'brew', steps: [{ command: 'brew', args: ['install', 'ffmpeg'] }] };
  }

  return null;
}

function formatStep(step: InstallStep): string {
  return [step.command, ...step.args].join(' ');
}

function formatPlan(plan: InstallerPlan): string {
  return plan.steps.map(formatStep).join(' && ');
}

export async function ensureFfmpegForTts(
  opts: NativeDepsOptions = {},
): Promise<string | undefined> {
  const binary = opts.binary?.trim() || 'ffmpeg';
  const commandExists = opts.commandExists ?? defaultCommandExists;
  const commandPath = opts.commandPath ?? defaultCommandPath;
  const stdout = opts.stdout ?? ((text: string) => process.stdout.write(text));
  const runStep = opts.runStep ?? defaultRunStep;
  const confirm =
    opts.confirm ??
    (async () => {
      const { confirm: promptConfirm } = await import('@inquirer/prompts');
      return promptConfirm({
        message: `ffmpeg is required for modulus-voice. Install it now?`,
        default: true,
      });
    });

  if (commandExists(binary)) {
    const found = commandPath(binary) ?? binary;
    stdout(`  ✓ ffmpeg found (${found}).\n`);
    return found;
  }

  const plan = detectFfmpegInstaller({
    platform: opts.platform,
    commandExists,
    getuid: opts.getuid,
  });

  if (!plan) {
    stdout(
      '  ffmpeg was not found, and Modulus could not detect a supported package manager.\n' +
        '  Install ffmpeg manually or set `ffmpeg_bin` with `modulus config`.\n',
    );
    return undefined;
  }

  const shouldInstall = await confirm(
    `ffmpeg is required for modulus-voice and was not found. Install it now with ${plan.name}? (${formatPlan(plan)})`,
    true,
  );
  if (!shouldInstall) {
    stdout('  Skipped ffmpeg install. Voice notes will not work until ffmpeg is available.\n');
    return undefined;
  }

  for (const step of plan.steps) {
    stdout(`  → ${formatStep(step)}\n`);
    const status = runStep(step);
    if (status !== 0) {
      stdout(
        `  ffmpeg install failed while running \`${formatStep(step)}\` (exit ${status ?? 'unknown'}).\n` +
          '  Install ffmpeg manually or set `ffmpeg_bin` with `modulus config`.\n',
      );
      return undefined;
    }
  }

  if (commandExists(binary)) {
    const found = commandPath(binary) ?? binary;
    stdout(`  ✓ ffmpeg installed (${found}).\n`);
    return found;
  }

  stdout(
    '  ffmpeg install finished, but this shell still cannot find `ffmpeg`.\n' +
      '  Restart your terminal or set `ffmpeg_bin` with `modulus config`.\n',
  );
  return undefined;
}

interface PiperAsset {
  archive: string;
  executable: string;
}

function piperAssetFor(platform: NodeJS.Platform, arch: string): PiperAsset | null {
  if (platform === 'win32' && arch === 'x64') {
    return { archive: 'piper_windows_amd64.zip', executable: 'piper.exe' };
  }
  if (platform === 'linux') {
    if (arch === 'x64') return { archive: 'piper_linux_x86_64.tar.gz', executable: 'piper' };
    if (arch === 'arm64') return { archive: 'piper_linux_aarch64.tar.gz', executable: 'piper' };
    if (arch === 'arm') return { archive: 'piper_linux_armv7l.tar.gz', executable: 'piper' };
  }
  if (platform === 'darwin') {
    if (arch === 'x64') return { archive: 'piper_macos_x64.tar.gz', executable: 'piper' };
    if (arch === 'arm64') return { archive: 'piper_macos_aarch64.tar.gz', executable: 'piper' };
  }
  return null;
}

function findExecutable(dir: string, name: string): string | undefined {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    const s = statSync(path);
    if (s.isDirectory()) {
      const found = findExecutable(path, name);
      if (found) return found;
    } else if (entry === name) {
      return path;
    }
  }
  return undefined;
}

export async function ensurePiperForTts(opts: NativeDepsOptions = {}): Promise<string | undefined> {
  const binary = opts.binary?.trim() || 'piper';
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const commandExists = opts.commandExists ?? defaultCommandExists;
  const commandPath = opts.commandPath ?? defaultCommandPath;
  const stdout = opts.stdout ?? ((text: string) => process.stdout.write(text));
  const downloadFile = opts.downloadFile ?? defaultDownloadFile;
  const extractArchive = opts.extractArchive ?? defaultExtractArchive;
  const home = opts.home;

  if (commandExists(binary)) {
    const found = commandPath(binary) ?? binary;
    stdout(`  ✓ Piper found (${found}).\n`);
    return found;
  }

  if (!home) {
    stdout('  Piper was not found. Run `modulus ext install modulus-voice` to auto-download it.\n');
    return undefined;
  }

  const asset = piperAssetFor(platform, arch);
  if (!asset) {
    stdout(
      `  Piper was not found, and Modulus does not have a Piper binary for ${platform}/${arch}.\n` +
        '  Install Piper manually or set `piper_bin` with `modulus config`.\n',
    );
    return undefined;
  }

  const installDir = join(
    home,
    'module_state',
    'modulus-voice',
    'native',
    `piper-${PIPER_VERSION}`,
  );
  const existing = findExecutable(installDir, asset.executable);
  if (existing) {
    stdout(`  ✓ Piper ready (${existing}).\n`);
    return existing;
  }

  mkdirSync(installDir, { recursive: true });
  const archivePath = join(installDir, asset.archive);
  const url = `${PIPER_RELEASE_BASE}/${asset.archive}`;
  stdout(`  → Downloading Piper ${PIPER_VERSION} for ${platform}/${arch}...\n`);

  try {
    await downloadWithPartFile(url, archivePath, downloadFile);
    const status = await extractArchive(archivePath, installDir);
    rmSync(archivePath, { force: true });
    if (status !== 0) {
      stdout(`  Piper extraction failed (exit ${status ?? 'unknown'}).\n`);
      return undefined;
    }
    const installed = findExecutable(installDir, asset.executable);
    if (!installed) {
      stdout('  Piper downloaded, but Modulus could not find the Piper executable.\n');
      return undefined;
    }
    try {
      chmodSync(installed, 0o755);
    } catch {
      /* Windows/no-op */
    }
    stdout(`  ✓ Piper installed (${installed}).\n`);
    return installed;
  } catch (e) {
    rmSync(archivePath, { force: true });
    stdout(
      `  Piper download failed: ${e instanceof Error ? e.message : String(e)}\n` +
        '  Install Piper manually or set `piper_bin` with `modulus config`.\n',
    );
    return undefined;
  }
}

interface VoiceSpec {
  id: string;
  modelUrl: string;
  configUrl: string;
}

function voiceSpecFor(id: string): VoiceSpec {
  const parts = id.split('-');
  if (parts.length !== 3) {
    throw new Error(
      `invalid Piper voice id '${id}' - expected '<lang_country>-<voice>-<quality>' (e.g. en_GB-alan-medium)`,
    );
  }
  const [langCountry, voice, quality] = parts as [string, string, string];
  const lang = langCountry.split('_')[0]!;
  const base = `https://huggingface.co/rhasspy/piper-voices/resolve/main/${lang}/${langCountry}/${voice}/${quality}/${id}.onnx`;
  return { id, modelUrl: base, configUrl: `${base}.json` };
}

export async function ensureVoiceModelForTts(
  opts: NativeDepsOptions = {},
): Promise<string | undefined> {
  const home = opts.home;
  const stdout = opts.stdout ?? ((text: string) => process.stdout.write(text));
  const downloadFile = opts.downloadFile ?? defaultDownloadFile;
  const voiceId = opts.voiceId?.trim() || DEFAULT_VOICE_ID;

  if (!home) {
    stdout('  Voice model cannot be downloaded without a Modulus home directory.\n');
    return undefined;
  }

  let spec: VoiceSpec;
  try {
    spec = voiceSpecFor(voiceId);
  } catch (e) {
    stdout(
      `  ${e instanceof Error ? e.message : String(e)}\n` +
        `  Falling back to ${DEFAULT_VOICE_ID}.\n`,
    );
    spec = voiceSpecFor(DEFAULT_VOICE_ID);
  }

  const dir = join(home, 'module_state', 'modulus-voice', 'voices');
  const modelPath = join(dir, `${spec.id}.onnx`);
  const configPath = `${modelPath}.json`;
  if (existsSync(modelPath) && existsSync(configPath)) {
    stdout(`  ✓ Voice model ready (${modelPath}).\n`);
    return modelPath;
  }

  mkdirSync(dir, { recursive: true });
  stdout(`  → Downloading Piper voice model ${spec.id}...\n`);
  try {
    await downloadWithPartFile(spec.modelUrl, modelPath, downloadFile);
    stdout(`  → Downloading Piper voice config ${spec.id}...\n`);
    await downloadWithPartFile(spec.configUrl, configPath, downloadFile);
    stdout(`  ✓ Voice model installed (${modelPath}).\n`);
    return modelPath;
  } catch (e) {
    rmSync(modelPath, { force: true });
    rmSync(configPath, { force: true });
    stdout(
      `  Voice model download failed: ${e instanceof Error ? e.message : String(e)}\n` +
        '  It can still download on first reply, or set `voice_model_path` with `modulus config`.\n',
    );
    return undefined;
  }
}

// One-time migration for users who installed under the old module name
// (`modulus-tts`). Move any state directory the old module left behind so
// pre-downloaded Piper binaries and voice models don't get re-downloaded under
// the new name. Best-effort: if the rename fails (file lock, permission), we
// log via stdout and fall through to the normal download path.
function migrateStateDirFromTts(home: string, stdout: (text: string) => void): void {
  const oldDir = join(home, 'module_state', 'modulus-tts');
  const newDir = join(home, 'module_state', 'modulus-voice');
  if (!existsSync(oldDir)) return;
  if (existsSync(newDir)) {
    stdout(
      '  Note: ~/.modulus/module_state/modulus-tts/ still exists alongside modulus-voice/. ' +
        'Move or remove the old folder once you have confirmed the rename worked.\n',
    );
    return;
  }
  try {
    renameSync(oldDir, newDir);
    stdout(`  ✓ Migrated state from modulus-tts → modulus-voice (${newDir}).\n`);
  } catch (e) {
    stdout(
      `  Could not move ${oldDir} → ${newDir}: ${e instanceof Error ? e.message : String(e)}\n` +
        '  Downloads will populate the new location instead.\n',
    );
  }
}

export async function setup(ctx: ModuleSetupContext): Promise<void> {
  migrateStateDirFromTts(ctx.home, ctx.stdout);

  // Headless mode (web wizard): the user already consented to installing this
  // module when they toggled it on. Default native-dep prompts to "yes" so
  // ffmpeg/whisper actually land, instead of being silently skipped. If the
  // package manager itself fails (no sudo, no winget, etc.) the setup output
  // is surfaced back to the wizard so the user can act on it.
  const ffmpeg = await ensureFfmpegForTts({
    binary: String(ctx.settings.get('ffmpeg_bin', 'ffmpeg')),
    stdout: ctx.stdout,
    ...(ctx.interactive ? {} : { confirm: async () => true }),
  });
  if (ffmpeg) ctx.settings.set('ffmpeg_bin', ffmpeg);

  const piper = await ensurePiperForTts({
    binary: String(ctx.settings.get('piper_bin', 'piper')),
    home: ctx.home,
    stdout: ctx.stdout,
  });
  if (piper) ctx.settings.set('piper_bin', piper);

  const voiceModel = await ensureVoiceModelForTts({
    voiceId: String(ctx.settings.get('voice_id', '')),
    home: ctx.home,
    stdout: ctx.stdout,
  });
  if (voiceModel) ctx.settings.set('voice_model_path', voiceModel);

  const whisperBin = await ensureWhisperForVoice({
    binary: String(ctx.settings.get('whisper_bin', 'whisper-cli')),
    home: ctx.home,
    stdout: ctx.stdout,
    ...(ctx.interactive ? {} : { confirm: async () => true }),
  });
  if (whisperBin) ctx.settings.set('whisper_bin', whisperBin);

  const whisperModel = await ensureWhisperModel({
    modelId: String(ctx.settings.get('whisper_model_id', DEFAULT_WHISPER_MODEL)),
    home: ctx.home,
    stdout: ctx.stdout,
  });
  if (whisperModel) ctx.settings.set('whisper_model_path', whisperModel);
}

// ---------------------------------------------------------------------------
// Whisper.cpp bootstrap
// ---------------------------------------------------------------------------

const DEFAULT_WHISPER_MODEL = 'ggml-base.en';
const WHISPER_MODEL_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

// Whisper.cpp's release assets aren't as platform-uniform as Piper's. Rather
// than ship a brittle download table for every distro we discover whisper-cli
// via $PATH first; if it's missing, offer a package-manager install where one
// exists and fall back to a manual-install pointer otherwise. This mirrors
// the ffmpeg pattern above, which has held up across Linux distros, macOS,
// and Windows.
export function detectWhisperInstaller(
  opts: Pick<NativeDepsOptions, 'platform' | 'commandExists' | 'getuid'> = {},
): InstallerPlan | null {
  const platform = opts.platform ?? process.platform;
  const commandExists = opts.commandExists ?? defaultCommandExists;
  const getuid = opts.getuid ?? (() => process.getuid?.());

  if (platform === 'darwin' && commandExists('brew')) {
    return {
      name: 'brew',
      steps: [{ command: 'brew', args: ['install', 'whisper-cpp'] }],
    };
  }

  const priv = (command: string, args: string[]): InstallStep =>
    withPrivilege(command, args, { commandExists, getuid });

  if (platform !== 'win32') {
    // whisper-cpp landed in Homebrew on Linux (linuxbrew) and in some
    // distro repos under names like `whisper-cpp` or `whisper.cpp`. We
    // probe the most reliable: brew on Linux, then apt/pacman.
    if (commandExists('brew')) {
      return { name: 'brew', steps: [{ command: 'brew', args: ['install', 'whisper-cpp'] }] };
    }
    if (commandExists('pacman')) {
      return {
        name: 'pacman',
        steps: [priv('pacman', ['-Sy', '--noconfirm', 'whisper.cpp'])],
      };
    }
    if (commandExists('apt-get')) {
      // Debian/Ubuntu don't ship a `whisper-cpp` package as of writing;
      // returning null forces the manual-install message rather than running
      // an apt-get that won't find the package.
      return null;
    }
  }

  return null;
}

// Windows has no reliable package manager for whisper.cpp, but the project
// publishes prebuilt binaries on most releases. Pin a known-good version that
// actually ships Windows zips and fetch the matching archive — mirrors the
// Piper auto-download path so toggling modulus-voice from the wizard ends in
// a working whisper-cli without forcing the user to install C++ tooling.
//
// IMPORTANT: not every whisper.cpp release ships Windows binaries — v1.7.5
// only published an iOS xcframework, so the original pin pointed at a 404.
// Verify with `curl -I https://github.com/ggerganov/whisper.cpp/releases/
// download/<version>/whisper-bin-x64.zip` before bumping.
const WHISPER_VERSION = 'v1.8.5';
const WHISPER_RELEASE_BASE = `https://github.com/ggerganov/whisper.cpp/releases/download/${WHISPER_VERSION}`;

interface WhisperAsset {
  archive: string;
  executable: string;
}

function whisperAssetFor(platform: NodeJS.Platform, arch: string): WhisperAsset | null {
  if (platform === 'win32') {
    if (arch === 'x64') return { archive: 'whisper-bin-x64.zip', executable: 'whisper-cli.exe' };
    if (arch === 'ia32') return { archive: 'whisper-bin-Win32.zip', executable: 'whisper-cli.exe' };
  }
  return null;
}

async function downloadWhisperBinary(
  asset: WhisperAsset,
  home: string,
  helpers: Pick<NativeDepsOptions, 'stdout' | 'downloadFile' | 'extractArchive'>,
): Promise<string | undefined> {
  const stdout = helpers.stdout ?? ((text: string) => process.stdout.write(text));
  const downloadFile = helpers.downloadFile ?? defaultDownloadFile;
  const extractArchive = helpers.extractArchive ?? defaultExtractArchive;

  const installDir = join(
    home,
    'module_state',
    'modulus-voice',
    'native',
    `whisper-${WHISPER_VERSION}`,
  );
  const existing = findExecutable(installDir, asset.executable);
  if (existing) {
    stdout(`  ✓ whisper.cpp ready (${existing}).\n`);
    return existing;
  }

  mkdirSync(installDir, { recursive: true });
  const archivePath = join(installDir, asset.archive);
  const url = `${WHISPER_RELEASE_BASE}/${asset.archive}`;
  stdout(
    `  → Downloading whisper.cpp ${WHISPER_VERSION} for ${process.platform}/${process.arch}...\n`,
  );
  try {
    await downloadWithPartFile(url, archivePath, downloadFile);
    const status = await extractArchive(archivePath, installDir);
    rmSync(archivePath, { force: true });
    if (status !== 0) {
      stdout(`  whisper.cpp extraction failed (exit ${status ?? 'unknown'}).\n`);
      return undefined;
    }
    const installed = findExecutable(installDir, asset.executable);
    if (!installed) {
      stdout('  whisper.cpp downloaded, but Modulus could not find whisper-cli in the archive.\n');
      return undefined;
    }
    try {
      chmodSync(installed, 0o755);
    } catch {
      /* Windows/no-op */
    }
    stdout(`  ✓ whisper.cpp installed (${installed}).\n`);
    return installed;
  } catch (e) {
    rmSync(archivePath, { force: true });
    stdout(
      `  whisper.cpp download failed: ${e instanceof Error ? e.message : String(e)}\n` +
        '  Install manually (https://github.com/ggerganov/whisper.cpp/releases) and set `whisper_bin`\n' +
        '  with `modulus config modulus-voice whisper_bin <path>`.\n',
    );
    return undefined;
  }
}

// Stream a child process's stdout+stderr through `onChunk` as bytes arrive.
// Used by the Linux source-build fallback below: a multi-minute cmake compile
// going dark in the wizard's progress modal reads as a hang. Falls back to a
// resolved -1 status on spawn errors so the caller can surface a real message.
async function streamingRunStep(
  step: InstallStep,
  onChunk: (text: string) => void,
  cwd?: string,
): Promise<number | null> {
  return new Promise((resolveRun) => {
    const child = spawn(step.command, step.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(cwd ? { cwd } : {}),
    });
    const safe = (d: Buffer): void => {
      try {
        onChunk(d.toString('utf8'));
      } catch {
        /* SSE peer disconnected; keep the build going */
      }
    };
    child.stdout?.on('data', safe);
    child.stderr?.on('data', safe);
    child.on('close', (code) => resolveRun(code));
    child.on('error', (e) => {
      try {
        onChunk(`spawn failed: ${e instanceof Error ? e.message : String(e)}\n`);
      } catch {
        /* ignore */
      }
      resolveRun(-1);
    });
  });
}

// Static cmake release. Kitware publishes single-binary Linux/macOS tarballs
// with no install step — we drop one under module_state and use it for the
// whisper build. The point is to keep the wizard's setup path sudo-free: a
// detached panel has no tty, so 'sudo apt-get install cmake' fails silently.
const CMAKE_VERSION = '3.30.5';
const CMAKE_RELEASE_BASE = `https://github.com/Kitware/CMake/releases/download/v${CMAKE_VERSION}`;

interface CmakeAsset {
  archive: string;
  // Path INSIDE the extracted tarball where bin/cmake lives. macOS hides it
  // under CMake.app, Linux at the top level.
  binSubdir: string;
}

function cmakeAssetFor(platform: NodeJS.Platform, arch: string): CmakeAsset | null {
  if (platform === 'linux') {
    if (arch === 'x64') {
      return {
        archive: `cmake-${CMAKE_VERSION}-linux-x86_64.tar.gz`,
        binSubdir: `cmake-${CMAKE_VERSION}-linux-x86_64`,
      };
    }
    if (arch === 'arm64') {
      return {
        archive: `cmake-${CMAKE_VERSION}-linux-aarch64.tar.gz`,
        binSubdir: `cmake-${CMAKE_VERSION}-linux-aarch64`,
      };
    }
  }
  if (platform === 'darwin') {
    return {
      archive: `cmake-${CMAKE_VERSION}-macos-universal.tar.gz`,
      binSubdir: `cmake-${CMAKE_VERSION}-macos-universal/CMake.app/Contents`,
    };
  }
  return null;
}

// Download + extract the static cmake binary into module_state. Returns the
// absolute path to the `cmake` executable inside the extracted tree, or null
// if we don't ship an asset for this platform/arch (caller falls back to a
// helpful manual-install message).
async function ensureStaticCmake(
  home: string,
  opts: NativeDepsOptions,
): Promise<string | undefined> {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const stdout = opts.stdout ?? ((text: string) => process.stdout.write(text));
  const downloadFile = opts.downloadFile ?? defaultDownloadFile;
  const extractArchive = opts.extractArchive ?? defaultExtractArchive;

  const asset = cmakeAssetFor(platform, arch);
  if (!asset) {
    stdout(`  No static cmake available for ${platform}/${arch}; install cmake manually.\n`);
    return undefined;
  }

  const installDir = join(
    home,
    'module_state',
    'modulus-voice',
    'native',
    `cmake-${CMAKE_VERSION}`,
  );
  const binPath = join(installDir, asset.binSubdir, 'bin', 'cmake');
  if (existsSync(binPath)) {
    stdout(`  ✓ cmake ready (${binPath}).\n`);
    return binPath;
  }

  try {
    mkdirSync(installDir, { recursive: true });
  } catch {
    /* already exists */
  }
  const archivePath = join(installDir, asset.archive);
  stdout(`  → Downloading cmake ${CMAKE_VERSION} for ${platform}/${arch}…\n`);
  try {
    await downloadWithPartFile(`${CMAKE_RELEASE_BASE}/${asset.archive}`, archivePath, downloadFile);
    const status = await extractArchive(archivePath, installDir);
    rmSync(archivePath, { force: true });
    if (status !== 0) {
      stdout(`  cmake extraction failed (exit ${status ?? 'unknown'}).\n`);
      return undefined;
    }
    if (!existsSync(binPath)) {
      stdout(`  cmake downloaded but binary not found at ${binPath}.\n`);
      return undefined;
    }
    try {
      chmodSync(binPath, 0o755);
    } catch {
      /* ignore */
    }
    stdout(`  ✓ cmake installed (${binPath}).\n`);
    return binPath;
  } catch (e) {
    try {
      rmSync(archivePath, { force: true });
    } catch {
      /* ignore */
    }
    stdout(`  cmake download failed: ${e instanceof Error ? e.message : String(e)}\n`);
    return undefined;
  }
}

// Build whisper.cpp from source on Linux/macOS when no pre-built binary or
// package is available (Debian/Ubuntu's main repos don't ship whisper-cpp).
// Sudo-free: when cmake is missing we download Kitware's static binary into
// module_state rather than 'sudo apt-get install cmake', because the
// detached panel has no tty and sudo would silently fail. Result is cached
// under native/whisper-<ver>-src/ so a re-enable is instant. Streams the
// compile through opts.stdout so the wizard modal stays alive — a Pi-class
// CPU compiles in a few minutes.
async function buildWhisperFromSource(
  home: string,
  opts: NativeDepsOptions,
): Promise<string | undefined> {
  const stdout = opts.stdout ?? ((text: string) => process.stdout.write(text));
  const commandExists = opts.commandExists ?? defaultCommandExists;

  const srcDir = join(
    home,
    'module_state',
    'modulus-voice',
    'native',
    `whisper-${WHISPER_VERSION}-src`,
  );
  const buildDir = join(srcDir, 'build');
  const builtPath = join(buildDir, 'bin', 'whisper-cli');
  if (existsSync(builtPath)) {
    stdout(`  ✓ whisper.cpp already built (${builtPath}).\n`);
    return builtPath;
  }

  // Compiler + git. We don't try to install these ourselves — they live in
  // distro packages that require sudo, which the panel can't drive without a
  // tty. On the vast majority of dev/headless installs they're already
  // present; if not, surface the one-line command the user should run.
  const compilerTools = ['git', 'make', 'g++'];
  const missingCompiler = compilerTools.filter((d) => !commandExists(d));
  if (missingCompiler.length > 0) {
    stdout(
      `  Missing build tools: ${missingCompiler.join(', ')}.\n` +
        `  These need root to install; the panel can't do that without a terminal.\n` +
        `  Run in a shell:  sudo apt-get install -y build-essential git\n` +
        `  Then re-enable Voice from the panel.\n`,
    );
    return undefined;
  }

  // cmake: prefer the system one if present, otherwise drop a static Kitware
  // binary under native/ so we don't need sudo.
  let cmakeBin = 'cmake';
  if (!commandExists('cmake')) {
    stdout(`  cmake is not on PATH; fetching a static build (no sudo needed)…\n`);
    const downloaded = await ensureStaticCmake(home, opts);
    if (!downloaded) {
      stdout(
        `  Could not provide cmake automatically. Install it manually with:\n` +
          `    sudo apt-get install -y cmake\n` +
          `  and re-enable Voice.\n`,
      );
      return undefined;
    }
    cmakeBin = downloaded;
  }

  // Source clone.
  if (!existsSync(srcDir)) {
    stdout(`  → git clone whisper.cpp ${WHISPER_VERSION} (shallow)…\n`);
    try {
      mkdirSync(dirname(srcDir), { recursive: true });
    } catch {
      /* already exists */
    }
    const status = await streamingRunStep(
      {
        command: 'git',
        args: [
          'clone',
          '--depth',
          '1',
          '--branch',
          WHISPER_VERSION,
          'https://github.com/ggerganov/whisper.cpp.git',
          srcDir,
        ],
      },
      stdout,
    );
    if (status !== 0) {
      // Leave no half-clone behind — a retry should start fresh.
      try {
        rmSync(srcDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      stdout(`  git clone failed (exit ${status ?? 'unknown'}).\n`);
      return undefined;
    }
  }

  // Configure.
  stdout(`  → ${cmakeBin} -S ${srcDir} -B ${buildDir}\n`);
  const cfgStatus = await streamingRunStep(
    {
      command: cmakeBin,
      args: ['-S', srcDir, '-B', buildDir, '-DCMAKE_BUILD_TYPE=Release'],
    },
    stdout,
  );
  if (cfgStatus !== 0) {
    stdout(`  cmake configure failed (exit ${cfgStatus ?? 'unknown'}).\n`);
    return undefined;
  }

  // Build whisper-cli.
  stdout(
    `  → ${cmakeBin} --build ${buildDir} --target whisper-cli (a few minutes on slow CPUs)…\n`,
  );
  const buildStatus = await streamingRunStep(
    {
      command: cmakeBin,
      args: ['--build', buildDir, '--target', 'whisper-cli', '--config', 'Release', '-j'],
    },
    stdout,
  );
  if (buildStatus !== 0) {
    stdout(`  cmake build failed (exit ${buildStatus ?? 'unknown'}).\n`);
    return undefined;
  }

  if (!existsSync(builtPath)) {
    stdout(`  Build finished but ${builtPath} is missing — whisper.cpp layout may have changed.\n`);
    return undefined;
  }
  try {
    chmodSync(builtPath, 0o755);
  } catch {
    /* Windows / no-op */
  }
  stdout(`  ✓ whisper.cpp built (${builtPath}).\n`);
  return builtPath;
}

export async function ensureWhisperForVoice(
  opts: NativeDepsOptions = {},
): Promise<string | undefined> {
  const binary = opts.binary?.trim() || 'whisper-cli';
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const commandExists = opts.commandExists ?? defaultCommandExists;
  const commandPath = opts.commandPath ?? defaultCommandPath;
  const stdout = opts.stdout ?? ((text: string) => process.stdout.write(text));
  const runStep = opts.runStep ?? defaultRunStep;
  const confirm =
    opts.confirm ??
    (async () => {
      const { confirm: promptConfirm } = await import('@inquirer/prompts');
      return promptConfirm({
        message: `whisper.cpp is required for voice-in. Install it now?`,
        default: true,
      });
    });

  // whisper.cpp's binary has shipped under both `whisper-cli` (modern releases)
  // and `whisper` / `main` (older builds, distro packages). Check the
  // configured name first, then fall back to common aliases before declaring
  // it missing so a user who installed via `brew install whisper-cpp` (which
  // installs `whisper-cli`) is picked up automatically.
  const candidates = Array.from(new Set([binary, 'whisper-cli', 'whisper-cpp', 'whisper']));
  for (const candidate of candidates) {
    if (commandExists(candidate)) {
      const found = commandPath(candidate) ?? candidate;
      stdout(`  ✓ whisper.cpp found (${found}).\n`);
      return found;
    }
  }

  // Prefer auto-download over package managers where we have a release asset
  // (currently Windows). Avoids requiring admin/sudo and works in the wizard's
  // headless setup path.
  const asset = whisperAssetFor(platform, arch);
  if (asset && opts.home) {
    const installed = await downloadWhisperBinary(asset, opts.home, {
      ...(opts.stdout !== undefined ? { stdout: opts.stdout } : {}),
      ...(opts.downloadFile !== undefined ? { downloadFile: opts.downloadFile } : {}),
      ...(opts.extractArchive !== undefined ? { extractArchive: opts.extractArchive } : {}),
    });
    if (installed) return installed;
    // Fall through: maybe a package manager is also available.
  }

  const plan = detectWhisperInstaller({
    platform: opts.platform,
    commandExists,
    getuid: opts.getuid,
  });

  if (!plan) {
    // Last resort on Linux/BSDs: clone whisper.cpp and build it. Debian and
    // Ubuntu don't ship a whisper-cpp package, so this is the only path that
    // works there without forcing the user to follow a README. Skipped when
    // we have no home dir (no place to cache the source/build).
    if (platform !== 'win32' && opts.home) {
      stdout('  No whisper.cpp package available for this system — building from source.\n');
      const built = await buildWhisperFromSource(opts.home, opts);
      if (built) return built;
    }
    stdout(
      '  whisper.cpp was not found, and Modulus could not install it automatically.\n' +
        '  Install it manually (https://github.com/ggerganov/whisper.cpp) and set `whisper_bin`\n' +
        '  with `modulus config modulus-voice whisper_bin <path>`.\n',
    );
    return undefined;
  }

  const shouldInstall = await confirm(
    `whisper.cpp is required for voice-in. Install it now with ${plan.name}?`,
    true,
  );
  if (!shouldInstall) {
    stdout('  Skipped whisper.cpp install. Voice transcription will not work until installed.\n');
    return undefined;
  }

  for (const step of plan.steps) {
    stdout(`  → ${[step.command, ...step.args].join(' ')}\n`);
    const status = runStep(step);
    if (status !== 0) {
      stdout(
        `  whisper.cpp install failed (exit ${status ?? 'unknown'}).\n` +
          '  Install manually or set `whisper_bin` with `modulus config`.\n',
      );
      return undefined;
    }
  }

  for (const candidate of candidates) {
    if (commandExists(candidate)) {
      const found = commandPath(candidate) ?? candidate;
      stdout(`  ✓ whisper.cpp installed (${found}).\n`);
      return found;
    }
  }

  stdout(
    '  whisper.cpp install finished, but this shell still cannot find a whisper binary.\n' +
      '  Restart your terminal or set `whisper_bin` with `modulus config`.\n',
  );
  return undefined;
}

export async function ensureWhisperModel(
  opts: NativeDepsOptions & { modelId?: string } = {},
): Promise<string | undefined> {
  const home = opts.home;
  const stdout = opts.stdout ?? ((text: string) => process.stdout.write(text));
  const downloadFile = opts.downloadFile ?? defaultDownloadFile;
  let modelId = (opts.modelId?.trim() || DEFAULT_WHISPER_MODEL).replace(/\.bin$/i, '');

  if (!home) {
    stdout('  whisper model cannot be downloaded without a Modulus home directory.\n');
    return undefined;
  }

  if (!/^ggml-[a-z0-9._-]+$/i.test(modelId)) {
    stdout(
      `  Invalid whisper model id '${modelId}'. Expected something like ggml-base.en or ggml-tiny.\n` +
        `  Falling back to ${DEFAULT_WHISPER_MODEL}.\n`,
    );
    // Actually fall back — otherwise the invalid id flows into the path and
    // download URL below, writing a bogus file the loader can never use.
    modelId = DEFAULT_WHISPER_MODEL.replace(/\.bin$/i, '');
  }

  const dir = join(home, 'module_state', 'modulus-voice', 'whisper-models');
  const modelPath = join(dir, `${modelId}.bin`);
  if (existsSync(modelPath)) {
    stdout(`  ✓ whisper model ready (${modelPath}).\n`);
    return modelPath;
  }

  mkdirSync(dir, { recursive: true });
  const url = `${WHISPER_MODEL_BASE}/${modelId}.bin`;
  stdout(`  → Downloading whisper model ${modelId}...\n`);
  try {
    await downloadWithPartFile(url, modelPath, downloadFile);
    stdout(`  ✓ whisper model installed (${modelPath}).\n`);
    return modelPath;
  } catch (e) {
    rmSync(modelPath, { force: true });
    stdout(
      `  whisper model download failed: ${e instanceof Error ? e.message : String(e)}\n` +
        '  Set `whisper_model_path` manually with `modulus config modulus-voice whisper_model_path <path>`.\n',
    );
    return undefined;
  }
}
