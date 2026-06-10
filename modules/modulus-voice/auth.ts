// First-run setup wizard for modulus-voice. Not "auth" in the OAuth sense — we
// reuse the auth flow plumbing because it's the cleanest way for an module
// to drive an interactive prompt and persist the result into
// module_settings. The wizard asks one yes/no question:
//
//   "Use the default voice (en_GB-northern_english_male-medium)?"
//
// If the user keeps the default we just persist that ID. If they want to
// change it, we offer a curated list of common English voices plus a free-form
// "type your own Piper voice ID" escape hatch.

import type { Host } from '../../src/core/modules.js';
import { CURATED_VOICES, DEFAULT_VOICE_ID, voiceSpecFor } from './voice.js';

function parseYesNo(raw: string, fallback: boolean): boolean {
  const v = raw.trim().toLowerCase();
  if (v === '') return fallback;
  if (v === 'y' || v === 'yes') return true;
  if (v === 'n' || v === 'no') return false;
  return fallback;
}

export function register(host: Host): void {
  host.auth.flow({
    label: 'Piper voice selection',
    run: async (io) => {
      io.print(
        'Modulus-tts ships with a default Piper voice — en_GB-northern_english_male-medium ' +
          '(British Northern English male, medium quality). It auto-downloads on first /voice use.',
      );

      const changeRaw = await io.prompt('Would you like to change from the default? [y/N]');
      const wantsChange = parseYesNo(changeRaw, false);

      if (!wantsChange) {
        io.print(`  Keeping default voice: ${DEFAULT_VOICE_ID}`);
        io.print('  No model path is needed; it will download on first /voice use.');
        return { voice_id: DEFAULT_VOICE_ID };
      }

      io.print('\nAvailable voices:');
      CURATED_VOICES.forEach((v, i) => {
        io.print(`  ${i + 1}. ${v.id}  —  ${v.label}`);
      });
      io.print(`  ${CURATED_VOICES.length + 1}. Enter a custom Piper voice ID`);

      const choice = (await io.prompt('Pick a voice (number):')).trim();
      const n = Number(choice);

      let chosenId: string;
      if (Number.isInteger(n) && n >= 1 && n <= CURATED_VOICES.length) {
        chosenId = CURATED_VOICES[n - 1]!.id;
      } else if (Number.isInteger(n) && n === CURATED_VOICES.length + 1) {
        const custom = (
          await io.prompt('Custom Piper voice ID (e.g. de_DE-thorsten-medium):')
        ).trim();
        chosenId = custom;
      } else {
        io.print(`  Unrecognized choice — keeping default ${DEFAULT_VOICE_ID}.`);
        return { voice_id: DEFAULT_VOICE_ID };
      }

      try {
        voiceSpecFor(chosenId);
      } catch (e) {
        io.print(
          `  ${e instanceof Error ? e.message : String(e)}\n  Keeping default ${DEFAULT_VOICE_ID}.`,
        );
        return { voice_id: DEFAULT_VOICE_ID };
      }

      io.print(`  ✓ Voice set to ${chosenId} (downloads on first /voice use).`);
      return { voice_id: chosenId };
    },
  });
}
