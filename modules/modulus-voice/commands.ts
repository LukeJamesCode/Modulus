// /voice command: toggles per-chat voice preferences.
//
//   /voice on|off|status — both directions at once (Piper TTS replies AND
//                          whisper.cpp transcription of voice notes).
//   /voice transcribe on|off|status — focused control of only voice-in,
//                          kept for cases where the user wants STT without
//                          spoken replies (or vice-versa via /voice off).
//
// The actual synthesis + transcription is wired in jobs.ts / voice-in.ts.

import type { Host } from '../../src/core/modules.js';
import { getPref, setBothPrefs, setSttPref, getSttPref } from './prefs.js';
import { DEFAULT_VOICE_ID } from './voice.js';

const USAGE = 'Usage: /voice on|off|status, or /voice transcribe on|off|status';

export function register(host: Host): void {
  host.telegram.command(
    'voice',
    async (ctx) => {
      const args = ctx.args.trim().toLowerCase().split(/\s+/).filter(Boolean);

      // Voice-in-only subcommand: `/voice transcribe …`. Useful when the user
      // wants STT but not spoken replies, or just to inspect that side.
      if (args[0] === 'transcribe') {
        const sub = args[1] ?? 'status';
        const fallback = Boolean(host.settings.get<boolean>('stt_default_enabled', false));

        if (sub === 'status') {
          const cur = getSttPref(host.db, ctx.chatId, fallback);
          await ctx.reply(`voice transcription: ${cur ? 'on' : 'off'}`);
          return;
        }
        if (sub !== 'on' && sub !== 'off') {
          await ctx.reply(USAGE);
          return;
        }
        setSttPref(host.db, ctx.chatId, sub === 'on');
        if (sub === 'on') {
          const modelPath = host.settings.get<string>('whisper_model_path', '');
          if (!modelPath) {
            await ctx.reply(
              'voice transcription on — but no whisper model is configured. Run `modulus ext install modulus-voice` to download one.',
            );
            return;
          }
          await ctx.reply('voice transcription on — send me a voice note.');
          return;
        }
        await ctx.reply('voice transcription off');
        return;
      }

      // Combined toggle: `/voice on|off|status` controls BOTH spoken replies
      // and inbound transcription so a single command sets up a full two-way
      // voice flow.
      const arg = args[0] ?? '';
      const ttsFallback = Boolean(host.settings.get<boolean>('default_enabled', false));
      const sttFallback = Boolean(host.settings.get<boolean>('stt_default_enabled', false));

      if (arg === '' || arg === 'status') {
        const ttsOn = getPref(host.db, ctx.chatId, ttsFallback);
        const sttOn = getSttPref(host.db, ctx.chatId, sttFallback);
        await ctx.reply(
          `voice replies: ${ttsOn ? 'on' : 'off'}\nvoice transcription: ${sttOn ? 'on' : 'off'}`,
        );
        return;
      }
      if (arg !== 'on' && arg !== 'off') {
        await ctx.reply(USAGE);
        return;
      }
      setBothPrefs(host.db, ctx.chatId, arg === 'on');
      if (arg === 'on') {
        const explicitModel = host.settings.get<string>('voice_model_path');
        const voiceId = host.settings.get<string>('voice_id', DEFAULT_VOICE_ID) || DEFAULT_VOICE_ID;
        const source = explicitModel
          ? `model: ${explicitModel}`
          : `voice: ${voiceId} (downloads on first reply)`;
        const whisperConfigured = !!host.settings.get<string>('whisper_model_path', '');
        const sttNote = whisperConfigured
          ? 'voice transcription on'
          : 'voice transcription on (but no whisper model configured — run `modulus ext install modulus-voice` to download one)';
        await ctx.reply(`voice replies on - ${source}\n${sttNote}`);
        return;
      }
      await ctx.reply('voice replies off\nvoice transcription off');
    },
    'Voice settings: /voice on|off|status (both directions), /voice transcribe on|off|status',
  );
}
