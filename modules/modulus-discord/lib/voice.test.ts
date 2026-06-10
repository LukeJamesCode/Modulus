import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseUserAudioMap } from './audio-map.js';

test('parseUserAudioMap: parses a simple single entry', () => {
  assert.deepEqual(parseUserAudioMap('123:/sounds/a.mp3'), [{ uid: '123', path: '/sounds/a.mp3' }]);
});

test('parseUserAudioMap: parses multiple entries', () => {
  assert.deepEqual(parseUserAudioMap('123:/a.mp3,456:/b.mp3'), [
    { uid: '123', path: '/a.mp3' },
    { uid: '456', path: '/b.mp3' },
  ]);
});

test('parseUserAudioMap: keeps commas that live inside a file path', () => {
  // The bug that bit us in production: an ElevenLabs export whose filename
  // contains ", " — a naive split on every comma severed the path.
  const raw =
    '599725756607758339:/home/modulus/uploads/Liam - Energetic, Social Media Creator_m2.mp3';
  assert.deepEqual(parseUserAudioMap(raw), [
    {
      uid: '599725756607758339',
      path: '/home/modulus/uploads/Liam - Energetic, Social Media Creator_m2.mp3',
    },
  ]);
});

test('parseUserAudioMap: splits two entries even when paths contain commas', () => {
  const raw =
    '796087902975164457:/uploads/Liam - Energetic, Social Media.mp3,' +
    '969080101138497536:/uploads/Other, Voice.mp3';
  assert.deepEqual(parseUserAudioMap(raw), [
    { uid: '796087902975164457', path: '/uploads/Liam - Energetic, Social Media.mp3' },
    { uid: '969080101138497536', path: '/uploads/Other, Voice.mp3' },
  ]);
});

test('parseUserAudioMap: tolerates whitespace around uid and path', () => {
  assert.deepEqual(parseUserAudioMap(' 123 : /a.mp3 , 456:/b.mp3 '), [
    { uid: '123', path: '/a.mp3' },
    { uid: '456', path: '/b.mp3' },
  ]);
});

test('parseUserAudioMap: drops an entry-boundary fragment that has no colon', () => {
  assert.deepEqual(parseUserAudioMap('garbage-no-colon,123:/a.mp3'), [
    { uid: '123', path: '/a.mp3' },
  ]);
});

test('parseUserAudioMap: empty input yields no entries', () => {
  assert.deepEqual(parseUserAudioMap(''), []);
});
