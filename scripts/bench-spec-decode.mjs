#!/usr/bin/env node
// Speculative-decoding benchmark for Phase 7.
//
// Runs a fixed prompt set through Ollama twice:
//   • baseline: the reasoning model (default qwen3.5:9b) alone
//   • speculative: same target model drafted by a small model (default
//     qwen3.5:0.5b) via Ollama's `draft_model` option, when supported.
//
// Reports total wall-clock and tokens/sec for each, plus the speed-up ratio.
// Exits non-zero if speculative is *slower* than baseline (a real regression
// signal — speculative shouldn't lose on CPU when draft acceptance is decent).
//
// Usage:
//   node scripts/bench-spec-decode.mjs                       # defaults
//   OLLAMA_URL=http://localhost:11434 \
//     TARGET_MODEL=qwen3.5:9b DRAFT_MODEL=qwen3.5:0.5b \
//     node scripts/bench-spec-decode.mjs
//
// This script is intentionally external to the build — it imports nothing
// from src/. It runs against any Ollama, even on a Pi.

const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/$/, '');
const TARGET_MODEL = process.env.TARGET_MODEL || 'qwen3.5:9b';
const DRAFT_MODEL = process.env.DRAFT_MODEL || 'qwen3.5:0.5b';
const NUM_PREDICT = Number.parseInt(process.env.NUM_PREDICT || '128', 10);
const RUNS = Number.parseInt(process.env.RUNS || '3', 10);

// A few prompts that hit different code paths. Short enough to keep the run
// reasonable on CPU.
const PROMPTS = [
  'Explain in one paragraph why deterministic prompt prefixes help LLM inference performance.',
  'Write a short Python function that computes the nth Fibonacci number iteratively.',
  'Summarize three trade-offs between SQLite and Postgres for a single-user agent.',
];

async function generate(model, prompt, opts) {
  const body = {
    model,
    prompt,
    stream: false,
    options: { num_predict: NUM_PREDICT, ...opts },
  };
  const t0 = process.hrtime.bigint();
  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const dt = Number(process.hrtime.bigint() - t0) / 1e9;
  if (!res.ok) {
    throw new Error(`Ollama HTTP ${res.status}: ${await res.text()}`);
  }
  const j = await res.json();
  const tokens = j.eval_count ?? 0;
  return { wall: dt, tokens, response: j.response ?? '' };
}

async function warmUp(model) {
  process.stdout.write(`  warming ${model}…\n`);
  await generate(model, 'hi', {});
}

function fmt(n, d = 2) {
  return n.toFixed(d);
}

async function main() {
  process.stdout.write(`Speculative-decoding benchmark\n`);
  process.stdout.write(`  ollama:  ${OLLAMA_URL}\n`);
  process.stdout.write(`  target:  ${TARGET_MODEL}\n`);
  process.stdout.write(`  draft:   ${DRAFT_MODEL}\n`);
  process.stdout.write(`  predict: ${NUM_PREDICT} tokens, ${RUNS} runs per prompt\n\n`);

  // Sanity: confirm both models exist.
  const tagsRes = await fetch(`${OLLAMA_URL}/api/tags`);
  if (!tagsRes.ok) {
    process.stderr.write(`Cannot reach Ollama at ${OLLAMA_URL}\n`);
    process.exit(2);
  }
  const tags = await tagsRes.json();
  const have = new Set((tags.models || []).map((m) => m.name));
  for (const m of [TARGET_MODEL, DRAFT_MODEL]) {
    if (!have.has(m) && !have.has(`${m}:latest`)) {
      process.stderr.write(`Model not pulled: ${m}. Run \`ollama pull ${m}\` first.\n`);
      process.exit(2);
    }
  }

  await warmUp(TARGET_MODEL);
  await warmUp(DRAFT_MODEL);

  const baseline = { wall: 0, tokens: 0 };
  const spec = { wall: 0, tokens: 0 };

  for (const prompt of PROMPTS) {
    process.stdout.write(`prompt: ${prompt.slice(0, 60)}…\n`);
    for (let i = 0; i < RUNS; i++) {
      const b = await generate(TARGET_MODEL, prompt, {});
      baseline.wall += b.wall;
      baseline.tokens += b.tokens;
      const s = await generate(TARGET_MODEL, prompt, { draft_model: DRAFT_MODEL });
      spec.wall += s.wall;
      spec.tokens += s.tokens;
      process.stdout.write(
        `  run ${i + 1}: baseline ${fmt(b.wall)}s (${fmt(b.tokens / b.wall, 1)} tok/s)` +
          `  spec ${fmt(s.wall)}s (${fmt(s.tokens / s.wall, 1)} tok/s)\n`,
      );
    }
  }

  const baseTokSec = baseline.tokens / baseline.wall;
  const specTokSec = spec.tokens / spec.wall;
  const speedup = specTokSec / baseTokSec;
  process.stdout.write(`\nSummary\n`);
  process.stdout.write(
    `  baseline:    ${fmt(baseline.wall)}s total, ${fmt(baseTokSec, 1)} tok/s\n`,
  );
  process.stdout.write(`  speculative: ${fmt(spec.wall)}s total, ${fmt(specTokSec, 1)} tok/s\n`);
  process.stdout.write(`  speed-up:    ${fmt(speedup, 2)}x\n`);

  if (speedup < 1.0) {
    process.stderr.write(
      `\nspec_decode regressed (${fmt(speedup, 2)}x). On CPU this can mean low draft ` +
        `acceptance — try a smaller draft model or check that your Ollama build supports ` +
        `the draft_model option.\n`,
    );
    process.exit(1);
  }
  if (speedup < 1.3) {
    process.stdout.write(
      `\nMarginal win. PLAN.md targets 1.5–2x; consider rejecting on this hardware.\n`,
    );
  } else {
    process.stdout.write(`\nSpeculative decoding wins on this box — keep it on for Heavy tier.\n`);
  }
}

main().catch((e) => {
  process.stderr.write(`bench-spec-decode failed: ${e.message ?? e}\n`);
  process.exit(2);
});
