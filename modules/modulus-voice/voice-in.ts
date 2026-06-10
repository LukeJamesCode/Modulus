// Inbound-voice handler: a Telegram voice note arrives, we download it,
// transcode via ffmpeg, run whisper.cpp, and hand the transcript back to the
// adapter so the orchestrator can answer the message the user spoke.
//
// Gated by a per-chat opt-in (`/voice transcribe on`) and a duration cap so a
// 5-minute monologue doesn't pin the user's Pi for half a minute. Errors are
// swallowed locally — the adapter falls back to a polite "couldn't transcribe"
// reply on its own.

import type { Host } from '../../src/core/modules.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSttPref } from './prefs.js';
import { transcribe, type RunShell } from './stt.js';

export interface RegisterOptions {
  // Override the STT implementation. Tests inject a stub so the wiring can be
  // exercised without whisper-cli installed.
  transcribeImpl?: typeof transcribe;
  // Forwarded to transcribe() when set; otherwise the real spawn is used.
  runShell?: RunShell;
}

export function register(host: Host, options: RegisterOptions = {}): void {
  const transcribeFn = options.transcribeImpl ?? transcribe;

  host.telegram.onVoiceMessage(async (msg) => {
    const fallbackEnabled = Boolean(host.settings.get<boolean>('stt_default_enabled', false));
    if (!getSttPref(host.db, msg.chatId, fallbackEnabled)) {
      // Not opted in for this chat — let the adapter fall through to its
      // generic "turn on /voice" reply. Only this branch returns skip; the
      // others below report a specific error so the user can act on it.
      return { skip: true };
    }

    const maxDur = Number(host.settings.get<number>('stt_max_duration_sec', 120));
    if (msg.durationSec > maxDur) {
      msg.log.info('voice note rejected (over max duration)', {
        durationSec: msg.durationSec,
        maxDur,
      });
      return {
        error: `Voice note is ${msg.durationSec}s — cap is ${maxDur}s (set stt_max_duration_sec to raise it).`,
      };
    }

    const whisperBin = host.settings.get<string>('whisper_bin', 'whisper-cli')!;
    const ffmpegBin = host.settings.get<string>('ffmpeg_bin', 'ffmpeg')!;
    const modelPath = host.settings.get<string>('whisper_model_path', '');
    if (!modelPath) {
      msg.log.warn('voice note failed: whisper_model_path is unset');
      return {
        error: 'No whisper model is configured. Run: modulus ext install modulus-voice',
      };
    }
    const language = host.settings.get<string>('stt_language', 'auto') || 'auto';

    const dir = mkdtempSync(join(tmpdir(), 'modulus-voice-in-'));
    const oggPath = join(dir, 'in.ogg');
    try {
      await msg.downloadToFile(oggPath);
      const result = await transcribeFn(
        { oggPath, whisperBin, ffmpegBin, modelPath, language },
        options.runShell,
      );
      if (!result.transcript) {
        msg.log.info('voice note transcribed to empty string', {
          durationSec: msg.durationSec,
        });
        return { error: "Couldn't make out any speech in that recording." };
      }
      return { transcript: result.transcript };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      msg.log.warn('voice transcription failed', { error: message });
      return { error: `Transcription failed: ${message}` };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
