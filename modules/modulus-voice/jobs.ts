// Outbound TTS after-reply hook + inbound voice-message handler. The
// adapter calls into us once a reply finishes streaming; we check the chat's
// voice pref, synthesize via Piper if enabled, and ship the resulting OGG as
// a Telegram voice note. The same module also registers the voice-in
// transcription handler so a single entrypoint covers both directions.
//
// Both hooks are fire-and-forget from the user's perspective: a synth or STT
// failure logs and skips, never re-throws into the orchestrator.

import type { Host } from '../../src/core/modules.js';
import type { Logger } from '../../src/util/log.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPref, prepForSpeech } from './prefs.js';
import { synthesize, type SynthRequest, type RunShell } from './synth.js';
import { transcribe } from './stt.js';
import { DEFAULT_VOICE, ensureVoiceModel, voiceSpecFor } from './voice.js';
import { register as registerVoiceIn } from './voice-in.js';

export interface RegisterOptions {
  // Override the synth implementation. Tests pass a stub so the hook can be
  // exercised without piper/ffmpeg installed.
  synth?: (req: SynthRequest, runShell?: RunShell) => Promise<{ oggPath: string; cleanup(): void }>;
}

export function register(host: Host, options: RegisterOptions = {}): void {
  const synthImpl = options.synth ?? synthesize;

  // Voice-in (STT) handler. Lives in its own module to keep this file
  // focused on the after-reply TTS path; we register it here so a single
  // jobs entrypoint covers both directions.
  registerVoiceIn(host);

  // Resolve the configured Piper voice model path, downloading the default on
  // first use. Shared by the Telegram afterReply hook and the panel TTS provider.
  async function resolveModelPath(log: Logger): Promise<string | null> {
    const explicitModel = host.settings.get<string>('voice_model_path');
    if (explicitModel) return explicitModel;
    const voiceId = host.settings.get<string>('voice_id', DEFAULT_VOICE.id)!;
    let spec = DEFAULT_VOICE;
    try {
      spec = voiceSpecFor(voiceId);
    } catch (e) {
      log.warn('invalid voice_id, falling back to default', {
        voice_id: voiceId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
    try {
      return await ensureVoiceModel(join(host.dataDir, 'voices'), log, spec);
    } catch {
      // ensureVoiceModel already logged. Skip this synth — the caller's text
      // reply already shipped; the user just doesn't get audio this turn.
      return null;
    }
  }

  // Synthesize an OGG clip for `text`, or null when it isn't speakable (empty /
  // too long) or the model can't be resolved. Pref-gating is the caller's job so
  // the Telegram and panel paths can each apply their own.
  async function synthOgg(
    text: string,
    log: Logger,
  ): Promise<{ oggPath: string; cleanup(): void } | null> {
    const modelPath = await resolveModelPath(log);
    if (!modelPath) return null;
    const piperBin = host.settings.get<string>('piper_bin', 'piper')!;
    const ffmpegBin = host.settings.get<string>('ffmpeg_bin', 'ffmpeg')!;
    const maxChars = Number(host.settings.get<number>('max_chars', 600));
    const speech = prepForSpeech(text, maxChars);
    if (!speech) {
      log.debug('skip voice: text empty or too long', { len: text.length });
      return null;
    }
    return synthImpl({ text: speech, piperBin, ffmpegBin, voiceModelPath: modelPath });
  }

  host.telegram.afterReply(async ({ chatId, text, log }) => {
    // Discord chat IDs are <= -8_000_000_000_001. We do not support sending
    // Telegram voice notes to Discord chat IDs.
    if (chatId <= -8000000000001) return;

    const fallback = Boolean(host.settings.get<boolean>('default_enabled', false));
    if (!getPref(host.db, chatId, fallback)) return;

    let result: { oggPath: string; cleanup(): void } | null = null;
    try {
      result = await synthOgg(text, log);
      if (result) await host.telegram.sendVoice(chatId, { path: result.oggPath });
    } catch (e) {
      log.warn('tts synth or send failed', {
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      result?.cleanup();
    }
  });

  // Panel two-way voice: contribute whisper.cpp STT + Piper TTS to core so the
  // Voice Hub / chat-window mic work over HTTP, not just Telegram. host.voice is
  // absent in test harnesses without a voice service, so register through `?.`.
  host.voice?.registerStt(async (audio, mime) => {
    const whisperBin = host.settings.get<string>('whisper_bin', 'whisper-cli')!;
    const ffmpegBin = host.settings.get<string>('ffmpeg_bin', 'ffmpeg')!;
    const modelPath = host.settings.get<string>('whisper_model_path', '');
    if (!modelPath) {
      throw new Error('No whisper model is configured. Run: modulus mod install modulus-voice');
    }
    const language = host.settings.get<string>('stt_language', 'auto') || 'auto';
    // The browser records webm/ogg opus; ffmpeg auto-detects the container, but
    // a matching extension keeps the temp file honest.
    const ext = mime.includes('ogg') ? 'ogg' : 'webm';
    const dir = mkdtempSync(join(tmpdir(), 'modulus-voice-panel-in-'));
    const inPath = join(dir, `in.${ext}`);
    try {
      writeFileSync(inPath, audio);
      const { transcript } = await transcribe({
        oggPath: inPath,
        whisperBin,
        ffmpegBin,
        modelPath,
        language,
      });
      return { transcript };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  host.voice?.registerTts(async (text, chatId) => {
    const fallback = Boolean(host.settings.get<boolean>('default_enabled', false));
    if (!getPref(host.db, chatId, fallback)) return null;
    let result: { oggPath: string; cleanup(): void } | null = null;
    try {
      result = await synthOgg(text, host.log);
      if (!result) return null;
      return { audio: readFileSync(result.oggPath), mime: 'audio/ogg' };
    } finally {
      result?.cleanup();
    }
  });
}
