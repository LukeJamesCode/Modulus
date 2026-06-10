import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import type { Host } from '../../src/core/modules.js';
import type { ToolHandler } from '../../src/core/tools.js';
import { register } from './tools.js';

// Minimal Host stub: captures registered tools and serves canned settings.
function fakeHost(settings: Record<string, unknown> = {}): { host: Host; tools: ToolHandler[] } {
  const tools: ToolHandler[] = [];
  const noop = (): void => {};
  const log = { info: noop, warn: noop, error: noop, debug: noop, child: () => log };
  const host = {
    settings: {
      get: (k: string, fb?: unknown) => (k in settings ? settings[k] : fb),
      set: noop,
      all: () => ({ ...settings }),
    },
    tools: {
      register: (h: ToolHandler) => tools.push(h),
      unregister: noop,
      onAfterExecute: () => noop,
    },
    telegram: { command: noop },
    prompts: { contribute: noop },
    log,
  } as unknown as Host;
  return { host, tools };
}

test('web_search is confirm-tier by default and exposes an approval prompt', () => {
  const { host, tools } = fakeHost();
  register(host);
  const ws = tools.find((t) => t.name === 'web_search')!;
  assert.equal(ws.tier, 'confirm');
  assert.ok(ws.confirmPrompt);
  const prompt = ws.confirmPrompt!({ query: 'how tides work' });
  assert.ok(/allow modulus to search/i.test(prompt));
  assert.ok(prompt.includes('how tides work'));
  assert.ok(prompt.includes('duckduckgo.com'));
});

test('web_search is auto-tier when confirm_before_search is turned off', () => {
  const { host, tools } = fakeHost({ confirm_before_search: false });
  register(host);
  const ws = tools.find((t) => t.name === 'web_search')!;
  assert.equal(ws.tier, 'auto');
});
