// Renders the ability-test results as the markdown report `modulus abilitytest`
// writes to ~/.modulus/ability-test-<ts>.md.
//
// CONTRACT: the status column and id must stay parseable by `modulus
// abilitytest --fails`, which re-runs failures by scanning the latest report
// with this regex (src/cli/index.ts):
//   /^\|\s+[✗!]\s+(?:fail|error)\s+\|\s+`([^`]+)`/
// So a failing row is `| ✗ fail | \`<id>\` | …` and an errored row is
// `| ! error | \`<id>\` | …`, with the id in backticks in column two. Don't
// change those cells without updating the CLI parser in lockstep.

export type Status = 'pass' | 'fail' | 'error';

export interface TestResult {
  id: string;
  ability: string;
  dimension: string;
  status: Status;
  detail: string;
  elapsedMs: number;
}

const STATUS_CELL: Record<Status, string> = {
  pass: '✓ pass',
  fail: '✗ fail',
  error: '! error',
};

function escapeCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function summarize(results: readonly TestResult[]): {
  pass: number;
  fail: number;
  error: number;
  total: number;
} {
  let pass = 0;
  let fail = 0;
  let error = 0;
  for (const r of results) {
    if (r.status === 'pass') pass++;
    else if (r.status === 'fail') fail++;
    else error++;
  }
  return { pass, fail, error, total: results.length };
}

export function renderReport(
  results: readonly TestResult[],
  tier: string,
  now: Date = new Date(),
): string {
  const s = summarize(results);
  const lines: string[] = [];
  lines.push(`# Modulus ability test — ${tier}`);
  lines.push('');
  lines.push(`Run at ${now.toISOString()} (deterministic FakeLLM subset).`);
  lines.push('');
  lines.push(`**${s.pass}/${s.total} passed** · ${s.fail} failed · ${s.error} errored.`);
  lines.push('');
  lines.push('| Status | Test | Ability | Dimension | Detail |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const r of results) {
    lines.push(
      `| ${STATUS_CELL[r.status]} | \`${r.id}\` | ${escapeCell(r.ability)} | ${escapeCell(
        r.dimension,
      )} | ${escapeCell(r.detail)} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

// One-line console row, e.g. "✓ pass  tool-weather            get_weather invoked".
export function consoleRow(r: TestResult): string {
  return `${STATUS_CELL[r.status]}  ${r.id.padEnd(22)} ${r.detail}`;
}
