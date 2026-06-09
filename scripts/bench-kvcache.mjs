#!/usr/bin/env node
// scripts/bench-kvcache.mjs
//
// Replays a synthetic multi-turn conversation through Ollama and reports
// `prompt_eval_count` per turn. Validates the "deterministic prompt order
// = KV-cache reuse" claim Modulus is built on: a stable prefix means each
// follow-up turn should only re-process the new tail, not re-tokenise the
// full system + history block.
//
// Read as a regression guard. Before reordering anything in
// `src/core/context.ts` or the daily anchor in `src/core/orchestrator.ts`,
// run this. After the change, run it again. The per-turn deltas should be
// roughly constant (one new user line per turn). If they balloon, the
// new prompt layout broke prefix stability and Ollama is re-encoding the
// whole prefix every turn.
//
// Usage:
//   node scripts/bench-kvcache.mjs [--turns 20] [--model qwen3.5:0.8b] [--url http://localhost:11434]
//
// Cleanly prints either a one-line summary (CI) or a per-turn table (local
// debugging via --verbose). Exits non-zero if Ollama is unreachable so a
// CI step using this won't silently pass.

const args = parseArgs(process.argv.slice(2));
const TURNS = Number(args.turns ?? 20);
const MODEL = String(args.model ?? 'qwen3.5:0.8b');
const URL = String(args.url ?? process.env.OLLAMA_URL ?? 'http://localhost:11434');
const VERBOSE = Boolean(args.verbose);

// Stable system prefix. Mirrors what the orchestrator builds: a fixed
// system message, no per-turn dynamic blocks (we leave the daily anchor out
// so a midnight roll-over during the bench doesn't muddy the numbers).
const SYSTEM = 'You are Modulus, a small terminal-first AI assistant. Be concise.';

// One short user line per turn. The actual content doesn't matter — what
// matters is that the prefix grows deterministically and Ollama can reuse
// the prior prefix's KV cache.
const USER_TURNS = Array.from(
  { length: TURNS },
  (_, i) => `Turn ${i + 1}: tell me a single short fact.`,
);

async function main() {
  const messages = [{ role: 'system', content: SYSTEM }];
  const samples = [];
  let firstPrompt = null;

  for (let i = 0; i < TURNS; i++) {
    messages.push({ role: 'user', content: USER_TURNS[i] });
    const t0 = Date.now();
    const res = await chatOnce(messages);
    const elapsed = Date.now() - t0;
    if (firstPrompt === null) firstPrompt = res.promptTokens;
    samples.push({
      turn: i + 1,
      promptTokens: res.promptTokens,
      completionTokens: res.completionTokens,
      elapsedMs: elapsed,
    });
    // Append the (truncated) assistant reply so the next turn's prefix
    // grows the way it would in production.
    messages.push({ role: 'assistant', content: res.text.slice(0, 200) });
    if (VERBOSE) {
      process.stdout.write(
        `  turn ${String(i + 1).padStart(2)} prompt=${res.promptTokens} ` +
          `completion=${res.completionTokens} elapsed=${elapsed}ms\n`,
      );
    }
  }

  // Summary. The interesting number is the per-turn delta in promptTokens —
  // a healthy KV-cache reuse pattern shows prompt growing by roughly the
  // user+assistant line length, NOT by the full prefix every turn.
  const last = samples[samples.length - 1];
  const avgDelta =
    samples
      .slice(1)
      .map((s, i) => s.promptTokens - samples[i].promptTokens)
      .reduce((a, b) => a + b, 0) / Math.max(1, samples.length - 1);
  const totalElapsed = samples.reduce((a, s) => a + s.elapsedMs, 0);
  process.stdout.write(
    JSON.stringify(
      {
        model: MODEL,
        turns: TURNS,
        firstPromptTokens: firstPrompt,
        lastPromptTokens: last.promptTokens,
        avgPromptDeltaPerTurn: Math.round(avgDelta * 10) / 10,
        totalElapsedMs: totalElapsed,
        // Smaller is better; if avgPromptDeltaPerTurn ≈ first prompt size
        // every turn, the cache prefix is breaking.
      },
      null,
      2,
    ) + '\n',
  );
}

async function chatOnce(messages) {
  const body = {
    model: MODEL,
    messages,
    stream: false,
    keep_alive: '5m',
    // Cap output so a chatty model doesn't dominate elapsed.
    options: { num_predict: 32 },
    think: false,
  };
  let res;
  try {
    res = await fetch(`${URL}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    process.stderr.write(`bench: ollama unreachable at ${URL}: ${e.message ?? e}\n`);
    process.exit(2);
  }
  if (!res.ok) {
    process.stderr.write(`bench: ollama responded ${res.status}: ${await res.text()}\n`);
    process.exit(2);
  }
  const j = await res.json();
  return {
    text: j.message?.content ?? '',
    promptTokens: j.prompt_eval_count ?? 0,
    completionTokens: j.eval_count ?? 0,
  };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

main().catch((e) => {
  process.stderr.write(`bench: ${e?.stack ?? e}\n`);
  process.exit(1);
});
