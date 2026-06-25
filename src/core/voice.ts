// Two-way panel voice. Core owns the HTTP surface — the Voice Hub and the chat
// window POST recordings to /api/chat/voice-in and play /api/chat/voice/:id —
// but the actual speech engines are a module's job. modulus-voice contributes
// whisper.cpp STT and Piper TTS through host.voice, exactly as a module
// contributes an LLM backend through host.llm.registerProvider. With no provider
// registered (the voice module disabled or absent) the routes report a friendly
// "not set up" instead of 404-ing, and the chat stream simply emits no clip.
//
// The clip store is one-shot and size-capped: the SSE `voice` event hands the
// browser an id, the browser fetches it once, and it's dropped. Capping the map
// means a clip synthesized but never fetched (tab closed mid-turn) can't leak
// memory on a long-lived daemon.

import { randomUUID } from 'node:crypto';

// Transcribe a recorded clip (a browser MediaRecorder blob — webm/ogg opus) to
// text. Throws on failure; the route maps that to a user-facing error string.
export type SttProvider = (audio: Buffer, mime: string) => Promise<{ transcript: string }>;

// Synthesize a spoken reply for a chat. Returns null when voice output is OFF
// for that chat — the per-chat pref decision stays in the module that owns it,
// so core never has to read module settings. Throws only on real synth failure.
export type TtsProvider = (
  text: string,
  chatId: number,
) => Promise<{ audio: Buffer; mime: string } | null>;

export interface VoiceService {
  // Module-facing registration (via host.voice). Returns a disposer that drops
  // the provider iff it's still the current one, so a hot-reload registering a
  // fresh provider before the old module's disposer runs can't clear it.
  registerStt(fn: SttProvider): () => void;
  registerTts(fn: TtsProvider): () => void;
  hasStt(): boolean;
  hasTts(): boolean;
  transcribe(audio: Buffer, mime: string): Promise<{ transcript: string }>;
  // Resolves to null when no provider is registered or voice is off for the chat.
  synthesize(text: string, chatId: number): Promise<{ audio: Buffer; mime: string } | null>;
  // One-shot clip store for TTS playback. putClip returns the fetch id.
  putClip(audio: Buffer, mime: string): string;
  takeClip(id: string): { audio: Buffer; mime: string } | undefined;
}

interface Clip {
  audio: Buffer;
  mime: string;
}

// Bound the unfetched-clip backlog. A handful is plenty — clips are consumed
// within a turn; anything older is a closed tab and safe to evict.
const MAX_CLIPS = 16;

export function createVoiceService(): VoiceService {
  let stt: SttProvider | null = null;
  let tts: TtsProvider | null = null;
  const clips = new Map<string, Clip>();

  return {
    registerStt(fn) {
      stt = fn;
      return () => {
        if (stt === fn) stt = null;
      };
    },
    registerTts(fn) {
      tts = fn;
      return () => {
        if (tts === fn) tts = null;
      };
    },
    hasStt: () => stt !== null,
    hasTts: () => tts !== null,
    transcribe(audio, mime) {
      if (!stt) return Promise.reject(new Error('no speech-to-text provider registered'));
      return stt(audio, mime);
    },
    synthesize(text, chatId) {
      if (!tts) return Promise.resolve(null);
      return tts(text, chatId);
    },
    putClip(audio, mime) {
      const id = randomUUID();
      clips.set(id, { audio, mime });
      // Evict oldest beyond the cap (Map preserves insertion order).
      while (clips.size > MAX_CLIPS) {
        const oldest = clips.keys().next().value;
        if (oldest === undefined) break;
        clips.delete(oldest);
      }
      return id;
    },
    takeClip(id) {
      const clip = clips.get(id);
      if (clip) clips.delete(id);
      return clip;
    },
  };
}
