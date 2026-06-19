import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { Host } from '../../src/core/modules.js';
import type { ToolHandler } from '../../src/core/tools.js';
import { register, unregister } from './tools.js';

// A fake MCP stdio server: reads JSON-RPC requests from stdin, replies on stdout.
// Exposes two tools, 'read' and 'write', and echoes call arguments back.
function fakeServerChild() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const events = new EventEmitter();
  let buf = '';
  stdin.on('data', (chunk: Buffer) => {
    buf += chunk.toString();
    for (;;) {
      const nl = buf.indexOf('\n');
      if (nl < 0) break;
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const req = JSON.parse(line) as Record<string, unknown>;
      const id = req['id'];
      let result: unknown;
      switch (req['method']) {
        case 'initialize':
          result = { protocolVersion: '2024-11-05' };
          break;
        case 'tools/list':
          result = {
            tools: [
              {
                name: 'read',
                description: 'reads a path',
                inputSchema: {
                  type: 'object',
                  properties: { path: { type: 'string' } },
                  required: ['path'],
                },
              },
              { name: 'write', inputSchema: { type: 'object' } },
            ],
          };
          break;
        case 'tools/call': {
          const params = req['params'] as { name: string; arguments: Record<string, unknown> };
          result = {
            content: [{ type: 'text', text: `${params.name}:${JSON.stringify(params.arguments)}` }],
          };
          break;
        }
        default:
          continue; // notification — no reply
      }
      stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
    }
  });
  return {
    stdin,
    stdout,
    stderr,
    on: (event: string, listener: (...args: unknown[]) => void) => events.on(event, listener),
    kill: () => {
      events.emit('exit', 0);
      return true;
    },
  };
}

function fakeHost(serversJson: string) {
  const registered: ToolHandler[] = [];
  const unregistered: string[] = [];
  const noop = (): void => {};
  const log = { info: noop, warn: noop, error: noop, debug: noop, child: () => log };
  const host = {
    settings: {
      get: (k: string, fb?: unknown) => (k === 'servers_json' ? serversJson : fb),
      set: noop,
    },
    spawn: () => fakeServerChild(),
    fetch: async () => new Response('{}'),
    tools: {
      register: (h: ToolHandler) => registered.push(h),
      unregister: (name: string) => unregistered.push(name),
      onAfterExecute: () => noop,
    },
    log,
  } as unknown as Host;
  return { host, registered, unregistered };
}

test('register connects a stdio server and exposes its tools with safe tiers', async () => {
  const { host, registered, unregistered } = fakeHost(
    JSON.stringify([{ name: 'test', transport: 'stdio', command: 'fake', autoTools: ['read'] }]),
  );
  await register(host);

  const read = registered.find((t) => t.name === 'mcp__test__read')!;
  const write = registered.find((t) => t.name === 'mcp__test__write')!;
  assert.ok(read, 'read tool registered as mcp__test__read');
  assert.ok(write, 'write tool registered as mcp__test__write');

  // autoTools promotes 'read' to auto; everything else stays confirm-tier.
  assert.equal(read.tier, 'auto');
  assert.equal(write.tier, 'confirm');
  assert.ok(write.confirmPrompt, 'confirm-tier tools carry an approval prompt');

  // inputSchema mapped through to parameters.
  assert.deepEqual(read.parameters['required'], ['path']);

  // A call round-trips through the client to the fake server.
  const out = await read.invoke({ path: '/etc/hosts' }, { log: host.log });
  assert.equal(out, 'read:{"path":"/etc/hosts"}');

  // unregister tears down every registered tool.
  await unregister(host);
  assert.deepEqual(new Set(unregistered), new Set(['mcp__test__read', 'mcp__test__write']));
});

test('invalid servers_json registers nothing and does not throw', async () => {
  const { host, registered } = fakeHost('not json');
  await register(host);
  assert.equal(registered.length, 0);
  await unregister(host);
});

test('a server with a bad name is skipped', async () => {
  const { host, registered } = fakeHost(
    JSON.stringify([{ name: 'has spaces!', transport: 'stdio', command: 'fake' }]),
  );
  await register(host);
  assert.equal(registered.length, 0);
  await unregister(host);
});
