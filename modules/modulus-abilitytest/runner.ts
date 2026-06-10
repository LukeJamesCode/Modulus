// `modulus abilitytest` runner. Boots a throwaway in-process orchestrator per
// test (temp SQLite, a scripted FakeLLM, the test's own tool set — no Telegram,
// no Ollama, no network), drives the user message through the REAL dispatch
// loop, and judges what the pipeline did against the catalog's expectations.
// Prints a row per test and writes the markdown report the CLI's --fails flag
// re-reads.
//
// The CLI (src/cli/index.ts) imports this file by path and calls run({tier,
// filter?, outFile?}); keep that signature stable.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../../src/storage/db.js';
import { createLogger } from '../../src/util/log.js';
import { createOrchestrator, type ReplyChunk } from '../../src/core/orchestrator.js';
import { createToolRegistry } from '../../src/core/tools.js';
import { ensurePrivateDir, homeDir } from '../../src/cli/config-store.js';
import { CATALOG, type AbilityTest, type Tier } from './catalog.js';
import { createScriptedLLM } from './fake-llm.js';
import { consoleRow, renderReport, summarize, type TestResult } from './report.js';

const TIER_RANK: Record<Tier, number> = { smoke: 0, standard: 1, full: 2 };

export interface RunOptions {
  tier: Tier;
  filter?: string;
  outFile?: string;
}

// Exposed so the in-process test can run the catalog without going through file
// output or process.exit. The CLI uses run() below.
export async function runCatalog(opts: {
  tier: Tier;
  filter?: string;
  catalog?: readonly AbilityTest[];
}): Promise<TestResult[]> {
  const wanted = TIER_RANK[opts.tier];
  const re = opts.filter ? new RegExp(opts.filter) : null;
  const selected = (opts.catalog ?? CATALOG).filter(
    (t) => TIER_RANK[t.tier] <= wanted && (!re || re.test(t.id) || re.test(t.ability)),
  );
  const results: TestResult[] = [];
  for (const t of selected) results.push(await runOne(t));
  return results;
}

async function runOne(t: AbilityTest): Promise<TestResult> {
  const started = Date.now();
  const base: Omit<TestResult, 'status' | 'detail' | 'elapsedMs'> = {
    id: t.id,
    ability: t.ability,
    dimension: t.dimension,
  };
  const dir = mkdtempSync(join(tmpdir(), 'modulus-abilitytest-'));
  const log = createLogger({ level: 'error', out: () => {}, err: () => {} });
  const db = open({ path: join(dir, 'g.db'), log });
  try {
    const invoked: string[] = [];
    const tools = createToolRegistry({ log });
    for (const spec of t.tools ?? []) {
      tools.register({
        name: spec.name,
        description: spec.description,
        tier: 'auto',
        parameters: spec.parameters ?? { type: 'object', properties: {} },
        invoke: async () => {
          invoked.push(spec.name);
          return spec.result ?? 'ok';
        },
      });
    }
    const llm = createScriptedLLM(t.script);
    const orch = createOrchestrator({ db, llm, tools, log });

    const chunks: ReplyChunk[] = [];
    await orch.handleUserMessage({
      chatId: 1,
      userId: 1,
      text: t.message,
      send: (c) => {
        chunks.push(c);
      },
    });
    await orch.shutdown();

    const reply = finalReply(chunks);
    const detail = judge(t, invoked, reply);
    return {
      ...base,
      status: detail.ok ? 'pass' : 'fail',
      detail: detail.detail,
      elapsedMs: Date.now() - started,
    };
  } catch (e) {
    return {
      ...base,
      status: 'error',
      detail: e instanceof Error ? e.message : String(e),
      elapsedMs: Date.now() - started,
    };
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function finalReply(chunks: readonly ReplyChunk[]): string {
  const last = chunks.at(-1);
  if (last?.replace !== undefined) return last.replace;
  return chunks.map((c) => c.delta).join('');
}

function judge(
  t: AbilityTest,
  invoked: readonly string[],
  reply: string,
): { ok: boolean; detail: string } {
  const ranSet = new Set(invoked);
  const lowerReply = reply.toLowerCase();
  const fails: string[] = [];

  for (const name of t.expect.toolsInvoked ?? []) {
    if (!ranSet.has(name)) fails.push(`expected tool '${name}' to run`);
  }
  for (const name of t.expect.toolsNotInvoked ?? []) {
    if (ranSet.has(name)) fails.push(`tool '${name}' should NOT have run`);
  }
  for (const sub of t.expect.replyIncludes ?? []) {
    if (!lowerReply.includes(sub.toLowerCase())) fails.push(`reply missing "${sub}"`);
  }

  if (fails.length > 0) return { ok: false, detail: fails.join('; ') };
  const ran = invoked.length > 0 ? `ran [${invoked.join(', ')}]` : 'no tools';
  return { ok: true, detail: ran };
}

function defaultOutFile(now: Date): string {
  const home = homeDir();
  ensurePrivateDir(home);
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return join(home, `ability-test-${stamp}.md`);
}

export async function run(opts: RunOptions): Promise<void> {
  const now = new Date();
  const results = await runCatalog(opts);

  for (const r of results) process.stdout.write(consoleRow(r) + '\n');
  const s = summarize(results);
  process.stdout.write(`\n${s.pass}/${s.total} passed · ${s.fail} failed · ${s.error} errored\n`);

  if (results.length === 0) {
    process.stdout.write('No tests matched the tier/filter.\n');
    return;
  }

  const outFile = opts.outFile ?? defaultOutFile(now);
  writeFileSync(outFile, renderReport(results, opts.tier, now), 'utf8');
  process.stdout.write(`Report written to ${outFile}\n`);

  if (s.fail > 0 || s.error > 0) process.exitCode = 1;
}
