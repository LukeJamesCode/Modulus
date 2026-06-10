import {
  joinVoiceChannel as discordJoinVoiceChannel,
  getVoiceConnection,
  VoiceConnection,
  EndBehaviorType,
  AudioPlayer,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  entersState,
  VoiceConnectionStatus,
  type DiscordGatewayAdapterCreator,
} from '@discordjs/voice';
import prism from 'prism-media';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';

class SilencingReadable extends Readable {
  private frames = 0;
  _read() {
    if (this.frames < 5) {
      this.push(Buffer.from([0xf8, 0xff, 0xfe]));
      this.frames++;
    } else {
      this.push(null);
    }
  }
}
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '../../../src/util/log.js';
import type { Bridge } from './bridge.js';
import type { AllowlistConfig } from './allowlist.js';
import { parseUserAudioMap } from './audio-map.js';
import { runWhisperOnWav, defaultRunShell } from '../../modulus-voice/stt.js';
import { synthesize } from '../../modulus-voice/synth.js';
import type { Host } from '../../../src/core/modules.js';

export interface VoiceManagerOptions {
  log: Logger;
  allowlist: () => AllowlistConfig;
  host: Host;
  bridge: () => Bridge | null;
}

export class VoiceManager {
  private log: Logger;
  private allowlist: () => AllowlistConfig;
  private host: Host;
  private bridge: () => Bridge | null;
  private players: Map<string, AudioPlayer> = new Map();
  private channelToGuild: Map<string, string> = new Map();

  constructor(opts: VoiceManagerOptions) {
    this.log = opts.log;
    this.allowlist = opts.allowlist;
    this.host = opts.host;
    this.bridge = opts.bridge;
  }

  // Exposed for tests or status
  public getConnection(guildId: string): VoiceConnection | undefined {
    return getVoiceConnection(guildId);
  }

  public async joinVoiceChannel(
    guildId: string,
    channelId: string,
    adapterCreator: DiscordGatewayAdapterCreator,
  ): Promise<void> {
    this.log.info('joining voice channel', { guildId, channelId });
    const connection = discordJoinVoiceChannel({
      channelId,
      guildId,
      adapterCreator,
      selfDeaf: false,
      selfMute: false,
    });

    const player = createAudioPlayer();
    player.on('error', (e) => {
      this.log.warn('audio player error', { error: e.message });
    });

    connection.on('stateChange', (oldState, newState) => {
      this.log.info('voice connection stateChange', { old: oldState.status, new: newState.status });
    });
    connection.on('debug', (msg) => {
      this.log.info('voice connection debug', { msg });
    });

    connection.subscribe(player);
    this.players.set(guildId, player);
    this.channelToGuild.set(channelId, guildId);

    connection.receiver.speaking.on('start', (userId) => {
      this.log.info('speaking event received', { userId });
      this.handleUserSpeaking(connection, guildId, channelId, userId).catch((e) => {
        this.log.warn('error handling user speaking', {
          error: e instanceof Error ? e.message : String(e),
        });
      });
    });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
      this.log.info('voice connection ready', { guildId });

      // Send a silent frame to open the Discord UDP socket for receiving audio.
      const silentResource = createAudioResource(new SilencingReadable(), {
        inputType: StreamType.Opus,
      });
      player.play(silentResource);
    } catch (e) {
      this.log.warn('voice connection failed to become ready', {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  public leaveVoiceChannel(guildId: string): void {
    const connection = getVoiceConnection(guildId);
    if (connection) {
      connection.destroy();
      this.players.delete(guildId);
      for (const [ch, g] of this.channelToGuild.entries()) {
        if (g === guildId) this.channelToGuild.delete(ch);
      }
      this.log.info('left voice channel', { guildId });
    }
  }

  private async handleUserSpeaking(
    connection: VoiceConnection,
    guildId: string,
    channelId: string,
    userId: string,
  ): Promise<void> {
    const allowedSet = this.allowlist().allowedDmUserIds;
    this.log.info('handleUserSpeaking called', { userId, allowedSetSize: allowedSet.size });
    if (!allowedSet.has(userId) && userId !== this.allowlist().botUserId) {
      this.log.info('user not in allowedDmUserIds', { userId });
      return;
    }

    // Taunt mode swaps the channel's personality: ON = soundboard (play this
    // user's talking sound, no assistant), OFF = normal voice assistant
    // (transcribe and listen for the "modulus" wake word). The two are mutually
    // exclusive, so in taunt mode we don't even subscribe to the audio.
    if (this.host.settings.get<boolean>('taunt_mode', false)) {
      const talkingSoundsStr = this.host.settings.get<string>('talking_sounds', '');
      for (const { uid, path } of parseUserAudioMap(talkingSoundsStr)) {
        if (uid === userId) {
          this.log.info('matched user talking sound', { userId, path });
          this.playLocalFile(guildId, path);
          break;
        }
      }
      return;
    }

    const audioStream = connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 500 },
    });

    const dir = mkdtempSync(join(tmpdir(), 'modulus-discord-vc-'));
    const wavPath = join(dir, 'in.wav');

    try {
      // Discord streams voice packets as Opus. We decode them to raw PCM (48kHz stereo),
      // and pipe that raw PCM into ffmpeg to downsample to 16kHz mono WAV for whisper.
      const decoder = new prism.opus.Decoder({ frameSize: 960, channels: 2, rate: 48000 });

      // The binaries (and model) live in modulus-voice's settings, where its
      // setup wizard persisted the resolved absolute paths after auto-download
      // / source-build. whisper-cli in particular is built under
      // ~/.modulus/module_state/modulus-voice/native/ and is NOT on $PATH, so
      // modulus-discord's own bare-name default would spawn-ENOENT.
      const voiceSettings = this.voiceSettings();
      const whisperBin =
        voiceSettings.get('whisper_bin') ||
        this.host.settings.get<string>('whisper_bin', 'whisper-cli');
      const ffmpegBin =
        voiceSettings.get('ffmpeg_bin') || this.host.settings.get<string>('ffmpeg_bin', 'ffmpeg');

      const ffmpegArgs = [
        '-y',
        '-f',
        's16le',
        '-ar',
        '48000',
        '-ac',
        '2',
        '-i',
        'pipe:0',
        '-ar',
        '16000',
        '-ac',
        '1',
        '-c:a',
        'pcm_s16le',
        '-f',
        'wav',
        wavPath,
      ];

      const ffmpegProcess = spawn(ffmpegBin, ffmpegArgs, { stdio: ['pipe', 'ignore', 'ignore'] });

      // Pipe the Opus stream into the PCM decoder, then into ffmpeg's stdin.
      audioStream.pipe(decoder).pipe(ffmpegProcess.stdin);

      await new Promise<void>((resolve, reject) => {
        ffmpegProcess.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`ffmpeg exited with code ${code}`));
        });
        ffmpegProcess.on('error', reject);
      });

      const modelPath = voiceSettings.get('whisper_model_path');

      if (!modelPath) {
        this.log.debug('voice-in skipped: modulus-voice whisper_model_path is missing');
        return;
      }

      const language = voiceSettings.get('stt_language') || 'auto';

      const result = await runWhisperOnWav(
        wavPath,
        { whisperBin, modelPath, language },
        defaultRunShell,
      );

      if (!result.transcript) return;

      const transcript = result.transcript.trim();
      const lower = transcript.toLowerCase();

      const wakeWords = ['hey modulus', 'modulus'];
      let wakeWordMatch = '';
      for (const w of wakeWords) {
        if (lower.startsWith(w)) {
          wakeWordMatch = transcript.slice(0, w.length);
          break;
        }
      }

      if (wakeWordMatch) {
        // Strip the wake word and any trailing punctuation/space
        let payload = transcript.slice(wakeWordMatch.length).trim();
        payload = payload.replace(/^[,.!?:]\s*/, '').trim();

        const b = this.bridge();
        if (!b) return;

        if (payload.length > 0) {
          this.log.info('wake word detected', { userId, payload });
          await b.handle({ userId, channelId, guildId, rawContent: payload });
        } else {
          this.log.info('wake word detected but no command followed', { userId });
          await b.handle({ userId, channelId, guildId, rawContent: "I'm here." });
        }
      }
    } catch (e) {
      this.log.warn('voice processing error', {
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  public async playAudio(channelId: string, text: string): Promise<void> {
    const guildId = this.channelToGuild.get(channelId);
    if (!guildId) return;

    const player = this.players.get(guildId);
    if (!player) return;

    // Source the piper/ffmpeg binaries and the voice model from modulus-voice's
    // settings (its setup wizard persisted resolved absolute paths there);
    // modulus-discord's own bare-name defaults would only work if they happen to
    // be on $PATH.
    const voiceSettings = this.voiceSettings();
    const piperBin =
      voiceSettings.get('piper_bin') || this.host.settings.get<string>('piper_bin', 'piper');
    const ffmpegBin =
      voiceSettings.get('ffmpeg_bin') || this.host.settings.get<string>('ffmpeg_bin', 'ffmpeg');
    const voiceModelPath = voiceSettings.get('voice_model_path');

    if (!voiceModelPath) {
      this.log.debug('voice-out skipped: modulus-voice voice_model_path is missing');
      return;
    }

    try {
      const connection = getVoiceConnection(guildId);
      if (connection) {
        await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
      }

      const result = await synthesize({
        text,
        piperBin,
        ffmpegBin,
        voiceModelPath,
      });

      const resource = createAudioResource(result.oggPath, {
        inputType: StreamType.OggOpus,
      });

      player.play(resource);

      // Clean up the temp directory after playing (the stream reads it). We might need to delay cleanup
      // until the player is idle, or resource is finished.
      player.once('idle', () => {
        result.cleanup();
      });
    } catch (e) {
      this.log.warn('tts processing error', { error: e instanceof Error ? e.message : String(e) });
    }
  }

  public handleVoiceStateUpdate(
    userId: string,
    oldChannelId: string | null,
    newChannelId: string | null,
    guildId: string,
  ): void {
    if (newChannelId && newChannelId !== oldChannelId) {
      const ourGuild = this.channelToGuild.get(newChannelId);
      if (ourGuild === guildId) {
        // Entrance sounds are a taunt-mode feature; in normal voice-assistant
        // mode the bot stays quiet when people come and go.
        if (!this.host.settings.get<boolean>('taunt_mode', false)) return;
        const entranceSoundsStr = this.host.settings.get<string>('entrance_sounds', '');
        for (const { uid, path } of parseUserAudioMap(entranceSoundsStr)) {
          if (uid === userId) {
            void this.playLocalFile(guildId, path);
            break;
          }
        }
      }
    }
  }

  // Read the sibling modulus-voice module's settings. Settings are
  // module-scoped, so we query the shared module_settings table directly
  // to reach modulus-voice's resolved binary/model paths.
  private voiceSettings(): Map<string, string> {
    const rows = this.host.db
      .prepare(`SELECT key, value FROM module_settings WHERE module = 'modulus-voice'`)
      .all() as Array<{ key: string; value: string }>;
    return new Map(rows.map((r) => [r.key, r.value]));
  }

  private async playLocalFile(guildId: string, filePath: string): Promise<void> {
    const player = this.players.get(guildId);
    if (!player) {
      this.log.warn('playLocalFile: no player found', { guildId });
      return;
    }

    try {
      const connection = getVoiceConnection(guildId);
      if (connection) {
        await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
      }
      this.log.info('playLocalFile: attempting createAudioResource', { filePath });
      const resource = createAudioResource(filePath);
      resource.playStream.on('error', (e) => {
        this.log.warn('playLocalFile stream error', { error: e.message, filePath });
      });
      player.play(resource);
      this.log.info('playLocalFile: played sound', { guildId, filePath });
    } catch (e) {
      this.log.warn('failed to play local file', {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
}
