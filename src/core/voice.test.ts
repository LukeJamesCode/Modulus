import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createVoiceService } from './voice.js';

test('voice: no provider → synthesize is null, transcribe throws, has* are false', async () => {
  const v = createVoiceService();
  assert.equal(v.hasStt(), false);
  assert.equal(v.hasTts(), false);
  assert.equal(await v.synthesize('hello', 1), null);
  await assert.rejects(() => v.transcribe(Buffer.from('x'), 'audio/webm'), /no speech-to-text/);
});

test('voice: registered providers are used, disposer clears only the current one', async () => {
  const v = createVoiceService();
  const offA = v.registerStt(async () => ({ transcript: 'A' }));
  assert.equal(v.hasStt(), true);
  assert.deepEqual(await v.transcribe(Buffer.from('x'), 'audio/webm'), { transcript: 'A' });

  // A newer registration wins; the older disposer must not clear it.
  v.registerStt(async () => ({ transcript: 'B' }));
  offA();
  assert.equal(v.hasStt(), true);
  assert.deepEqual(await v.transcribe(Buffer.from('x'), 'audio/webm'), { transcript: 'B' });

  const offTts = v.registerTts(async (text, chatId) => ({
    audio: Buffer.from(`${text}:${chatId}`),
    mime: 'audio/ogg',
  }));
  assert.equal(v.hasTts(), true);
  assert.deepEqual(await v.synthesize('hi', 7), { audio: Buffer.from('hi:7'), mime: 'audio/ogg' });
  offTts();
  assert.equal(v.hasTts(), false);
  assert.equal(await v.synthesize('hi', 7), null);
});

test('voice: clip store is one-shot', () => {
  const v = createVoiceService();
  const id = v.putClip(Buffer.from('audio'), 'audio/ogg');
  const first = v.takeClip(id);
  assert.deepEqual(first, { audio: Buffer.from('audio'), mime: 'audio/ogg' });
  // Second fetch is gone — the id is single-use.
  assert.equal(v.takeClip(id), undefined);
});

test('voice: clip store evicts the oldest past the cap', () => {
  const v = createVoiceService();
  // MAX_CLIPS is 16; put 17 and the first must have been evicted.
  const ids: string[] = [];
  for (let i = 0; i < 17; i++) ids.push(v.putClip(Buffer.from(String(i)), 'audio/ogg'));
  assert.equal(v.takeClip(ids[0]!), undefined, 'oldest clip should be evicted');
  assert.deepEqual(v.takeClip(ids[16]!), { audio: Buffer.from('16'), mime: 'audio/ogg' });
  assert.deepEqual(v.takeClip(ids[1]!), { audio: Buffer.from('1'), mime: 'audio/ogg' });
});
