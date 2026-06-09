import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { modelFamily } from './model-family.js';

// Family is keyed off the tag prefix, not an exact match, so every size and
// version of a family resolves the same way. The `thinking` value is what
// gates think-suppression in llm.ts — Gemma must be 'no' (Ollama errors on the
// `think` parameter), qwen3 'yes', anything else 'unknown'.
test('modelFamily classifies qwen3 tags as thinking + vision', () => {
  for (const tag of ['qwen3.5:0.8b', 'qwen3.5:9b', 'qwen3:4b']) {
    assert.deepEqual(modelFamily(tag), { family: 'qwen3', thinking: 'yes', vision: 'yes' });
  }
});

test('modelFamily treats gemma 2/3 as non-thinking, non-vision (fallback)', () => {
  for (const tag of ['gemma3:4b', 'gemma3:27b', 'gemma2:9b']) {
    assert.deepEqual(modelFamily(tag), { family: 'gemma', thinking: 'no', vision: 'no' });
  }
});

test('modelFamily treats gemma 4+ as thinking + vision', () => {
  for (const tag of [
    'gemma4:12b',
    'gemma-4:26b',
    'gemma5:8b',
    'hf.co/unsloth/gemma-4-E2B-it-qat-GGUF:UD-Q4_K_XL',
  ]) {
    assert.deepEqual(modelFamily(tag), { family: 'gemma', thinking: 'yes', vision: 'yes' });
  }
});

test('modelFamily leaves unknown families as unknown', () => {
  for (const tag of ['llama3.2:3b', 'mistral:7b', 'phi3:mini']) {
    assert.deepEqual(modelFamily(tag), { family: 'other', thinking: 'unknown', vision: 'unknown' });
  }
});
