import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { panelTokenPath } from './daemon.js';
import { run } from './status.js';

// Drive `status.run` against a throwaway MODULUS_HOME and capture its report via
// the injected writer. The Ollama probe just fails fast (connection refused on
// the default localhost URL) and the absent DB/metrics files degrade
// gracefully, so the only thing these assertions pin down is the panel section.
async function capture(home: string, options: { json?: boolean }): Promise<string> {
  const prevHome = process.env['MODULUS_HOME'];
  process.env['MODULUS_HOME'] = home;
  const chunks: string[] = [];
  try {
    await run({ ...options, write: (chunk) => chunks.push(chunk) });
  } finally {
    if (prevHome === undefined) delete process.env['MODULUS_HOME'];
    else process.env['MODULUS_HOME'] = prevHome;
  }
  return chunks.join('');
}

function mkHome(): string {
  return mkdtempSync(join(tmpdir(), 'modulus-status-test-'));
}

test('json includes the tokenized panel URL once the token file exists', async () => {
  const home = mkHome();
  try {
    writeFileSync(panelTokenPath(home), 'tok-abc123def456ghijklmno', 'utf8');
    const out = JSON.parse(await capture(home, { json: true })) as {
      panel: { enabled: boolean; url: string | null };
    };
    assert.equal(out.panel.enabled, true);
    // Default bind/port (127.0.0.1:7777) plus the token we wrote.
    assert.equal(out.panel.url, 'http://127.0.0.1:7777/?token=tok-abc123def456ghijklmno');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('json omits the panel URL when no token has been generated yet', async () => {
  const home = mkHome();
  try {
    const out = JSON.parse(await capture(home, { json: true })) as {
      panel: { enabled: boolean; url: string | null };
    };
    assert.equal(out.panel.enabled, true);
    assert.equal(out.panel.url, null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('json omits the panel URL when the panel is disabled, even with a token', async () => {
  const home = mkHome();
  try {
    writeFileSync(panelTokenPath(home), 'tok-abc123def456ghijklmno', 'utf8');
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({
        version: 3,
        telegram: { token: '', allowedIds: [] },
        ollama: { url: 'http://localhost:11434' },
        models: { chat: 'qwen3.5:0.8b' },
        panel: { enabled: false },
      }),
      'utf8',
    );
    const out = JSON.parse(await capture(home, { json: true })) as {
      panel: { enabled: boolean; url: string | null };
    };
    assert.equal(out.panel.enabled, false);
    assert.equal(out.panel.url, null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('text output shows a panel row with the URL when a token exists', async () => {
  const home = mkHome();
  try {
    writeFileSync(panelTokenPath(home), 'tok-abc123def456ghijklmno', 'utf8');
    const out = await capture(home, {});
    assert.match(out, /^panel\s+http:\/\/127\.0\.0\.1:7777\/\?token=tok-/m);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('text output has no panel row when no token exists', async () => {
  const home = mkHome();
  try {
    const out = await capture(home, {});
    assert.doesNotMatch(out, /^panel\s+http:/m);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
