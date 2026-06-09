import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { profilesForTier } from './profiles.js';

const MODELS = { chat: 'qwen3.5:0.8b', reason: 'qwen3.5:9b', tools: 'qwen3.5:1.7b' };

test('small tier keeps the original Pi-safe values', () => {
  const { profiles, budgetTokens } = profilesForTier('small', MODELS);
  assert.equal(profiles.chat?.contextTokens, 4096);
  assert.equal(profiles.chat?.numPredict, 512);
  assert.equal(profiles.chat?.keepAlive, '30m');
  assert.equal(budgetTokens, 3584);
});

test('heavy tier widens windows and budget over small', () => {
  const small = profilesForTier('small', MODELS);
  const heavy = profilesForTier('heavy', MODELS);
  assert.ok(heavy.profiles.chat!.contextTokens > small.profiles.chat!.contextTokens);
  assert.ok(heavy.budgetTokens > small.budgetTokens);
  assert.ok(heavy.profiles.reason!.contextTokens > small.profiles.reason!.contextTokens);
});

test('standard tier sits between small and heavy', () => {
  const small = profilesForTier('small', MODELS).budgetTokens;
  const standard = profilesForTier('standard', MODELS).budgetTokens;
  const heavy = profilesForTier('heavy', MODELS).budgetTokens;
  assert.ok(standard > small && standard < heavy);
});

test('idle-eviction and tool-result caps scale up with tier', () => {
  const small = profilesForTier('small', MODELS);
  const standard = profilesForTier('standard', MODELS);
  const heavy = profilesForTier('heavy', MODELS);
  assert.ok(small.idleEvictionMs < standard.idleEvictionMs);
  assert.ok(standard.idleEvictionMs < heavy.idleEvictionMs);
  assert.equal(small.toolResultMaxChars, 2000); // unchanged from original cap
  assert.ok(standard.toolResultMaxChars > small.toolResultMaxChars);
  assert.ok(heavy.toolResultMaxChars > standard.toolResultMaxChars);
});

test('num_batch is omitted on small but scales up on larger tiers', () => {
  const small = profilesForTier('small', MODELS);
  const standard = profilesForTier('standard', MODELS);
  const heavy = profilesForTier('heavy', MODELS);
  assert.equal(small.profiles.chat?.numBatch, undefined); // Ollama default (512)
  assert.equal(standard.profiles.chat?.numBatch, 1024);
  assert.equal(heavy.profiles.chat?.numBatch, 2048);
  // applies to every configured profile on the tier, not just chat
  assert.equal(heavy.profiles.reason?.numBatch, 2048);
  assert.equal(heavy.profiles.tools?.numBatch, 2048);
});

test('undefined tier falls back to small (conservative)', () => {
  const fallback = profilesForTier(undefined, MODELS);
  const small = profilesForTier('small', MODELS);
  assert.deepEqual(fallback, small);
});

test('reason and tools profiles only appear when their models are set', () => {
  const chatOnly = profilesForTier('heavy', { chat: 'qwen3.5:0.8b' });
  assert.ok(chatOnly.profiles.chat);
  assert.equal(chatOnly.profiles.reason, undefined);
  assert.equal(chatOnly.profiles.tools, undefined);
});

test('chat profile is never heavy; reason is heavy, tools is not', () => {
  const { profiles } = profilesForTier('heavy', MODELS);
  assert.equal(profiles.chat?.heavy, false);
  assert.equal(profiles.reason?.heavy, true);
  assert.equal(profiles.tools?.heavy, false);
});

test('prompt budget leaves completion headroom within the chat window', () => {
  for (const tier of ['small', 'standard', 'heavy'] as const) {
    const { profiles, budgetTokens } = profilesForTier(tier, MODELS);
    const ctx = profiles.chat!.contextTokens;
    const predict = profiles.chat!.numPredict ?? 0;
    assert.ok(
      budgetTokens + predict <= ctx,
      `${tier}: budget(${budgetTokens}) + numPredict(${predict}) must fit num_ctx(${ctx})`,
    );
  }
});
