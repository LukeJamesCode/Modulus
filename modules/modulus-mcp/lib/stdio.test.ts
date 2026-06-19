import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createMcpClient } from './client.js';
import { createStdioTransport, type SpawnLike } from './stdio.js';

// A fake MCP server over in-memory pipes: it reads newline-delimited JSON-RPC
// requests from its stdin and writes responses to its stdout, exactly as a real
// stdio server would. `handle` returns the full response object (or undefined for
// notifications, which get no reply).
function fakeStdioServer(handle: (req: Record<string, unknown>) => object | undefined) {
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
      const reply = handle(JSON.parse(line) as Record<string, unknown>);
      if (reply) stdout.write(JSON.stringify(reply) + '\n');
    }
  });
  const child = {
    stdin,
    stdout,
    stderr,
    on: (event: string, listener: (...args: unknown[]) => void) => events.on(event, listener),
    kill: () => {
      events.emit('exit', 0);
      return true;
    },
  };
  const spawn: SpawnLike = () => child;
  return { spawn };
}

test('stdio transport round-trips initialize, tools/list and tools/call', async () => {
  const { spawn } = fakeStdioServer((req) => {
    const id = req['id'];
    switch (req['method']) {
      case 'initialize':
        return { jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05' } };
      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id,
          result: { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] },
        };
      case 'tools/call': {
        const params = req['params'] as { arguments?: { msg?: string } };
        return {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: `echoed: ${params.arguments?.msg ?? ''}` }] },
        };
      }
      default:
        return undefined; // notifications get no reply
    }
  });

  const transport = createStdioTransport({ spawn, command: 'fake-server', args: [] });
  const client = createMcpClient(transport);
  await client.initialize();

  const tools = await client.listTools();
  assert.equal(tools.length, 1);
  assert.equal(tools[0]!.name, 'echo');

  const res = await client.callTool('echo', { msg: 'hi' });
  assert.equal(res.text, 'echoed: hi');
  assert.equal(res.isError, false);

  await client.close();
});

test('a server that exits rejects in-flight requests', async () => {
  // A server that never answers, so the request is in flight when we kill it.
  const { spawn } = fakeStdioServer(() => undefined);
  const transport = createStdioTransport({ spawn, command: 'fake', args: [] });
  const client = createMcpClient(transport);
  const inflight = client.listTools();
  await transport.close(); // emits 'exit' → onClose rejects pending requests
  await assert.rejects(inflight, /MCP server exited|MCP transport closed/);
});
