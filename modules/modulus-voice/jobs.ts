// Outbound TTS after-reply hook + inbound voice-message handler. The
// adapter calls into us once a reply finishes streaming; we check the chat's
// voice pref, synthesize via Piper if enabled, and ship the resulting OGG as
// a Telegram voice note. The same module also registers the voice-in
// transcription handler so a single entrypoint covers both directions.
//
// Both hooks are fire-and-forget from the user's perspective: a synth or STT
// failure logs and skips, never re-throws into the orchestrator.

import type { Host } from '../../src/core/modules.js';
import { join } from 'node:path';
import { getPref, prepForSpeech } from './prefs.js';
import { synthesize, type SynthRequest, type RunShell } from './synth.js';
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

  host.telegram.afterReply(async ({ chatId, text, log }) => {
    // Discord chat IDs are <= -8_000_000_000_001. We do not support sending
    // Telegram voice notes to Discord chat IDs.
    if (chatId <= -8000000000001) return;

    const fallback = Boolean(host.settings.get<boolean>('default_enabled', false));
    if (!getPref(host.db, chatId, fallback)) return;

    const explicitModel = host.settings.get<string>('voice_model_path');
    let modelPath: string;
    if (explicitModel) {
      modelPath = explicitModel;
    } else {
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
        modelPath = await ensureVoiceModel(join(host.dataDir, 'voices'), log, spec);
      } catch {
        // ensureVoiceModel already logged. Skip this synth — text reply
        // already shipped, the user just doesn't get a voice note this turn.
        return;
      }
    }
    const piperBin = host.settings.get<string>('piper_bin', 'piper')!;
    const ffmpegBin = host.settings.get<string>('ffmpeg_bin', 'ffmpeg')!;
    const maxChars = Number(host.settings.get<number>('max_chars', 600));

    const speech = prepForSpeech(text, maxChars);
    if (!speech) {
      log.debug('skip voice: text empty or too long', { len: text.length });
      return;
    }

    let result: { oggPath: string; cleanup(): void } | null = null;
    try {
      result = await synthImpl({ text: speech, piperBin, ffmpegBin, voiceModelPath: modelPath });
      await host.telegram.sendVoice(chatId, { path: result.oggPath });
    } catch (e) {
      log.warn('tts synth or send failed', {
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      result?.cleanup();
    }
  });
}
