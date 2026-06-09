import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { detectTier } from './tier.js';

const GB = 1024 * 1024 * 1024;

test('detectTier picks small under 12 GB on a small CPU (Pi-class)', () => {
  assert.equal(detectTier(4 * GB, 4), 'small');
  assert.equal(detectTier(8 * GB, 4), 'small');
  assert.equal(detectTier(11 * GB, 4), 'small');
});

test('detectTier picks standard between 12 and 24 GB on a small CPU', () => {
  assert.equal(detectTier(12 * GB, 4), 'standard');
  assert.equal(detectTier(16 * GB, 4), 'standard');
  assert.equal(detectTier(23 * GB, 4), 'standard');
});

test('detectTier picks heavy at 24 GB and above', () => {
  assert.equal(detectTier(24 * GB, 4), 'heavy');
  assert.equal(detectTier(32 * GB, 4), 'heavy');
  assert.equal(detectTier(64 * GB, 4), 'heavy');
});

test('detectTier bumps small → standard when the CPU has 8+ cores (WSL/Docker cap)', () => {
  assert.equal(detectTier(8 * GB, 8), 'standard');
  assert.equal(detectTier(8 * GB, 12), 'heavy');
});

test('detectTier bumps standard → heavy when the CPU has 12+ cores (5800H-class)', () => {
  assert.equal(detectTier(16 * GB, 16), 'heavy');
  assert.equal(detectTier(16 * GB, 12), 'heavy');
});

test('detectTier leaves heavy alone regardless of CPU count', () => {
  assert.equal(detectTier(32 * GB, 4), 'heavy');
  assert.equal(detectTier(32 * GB, 16), 'heavy');
});
