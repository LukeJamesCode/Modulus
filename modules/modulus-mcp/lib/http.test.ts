import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createMcpClient } from './client.js';
import { createHttpTransport } from './http.js';

// A fake fetch standing in for one MCP HTTP server. It reads the posted JSON-RPC
// request and returns a Response: JSON for most, an SSE body for tools/list (to
// exercise the event-stream path), and a session id header on initialize.
function fakeFetch(records: { sessionHeaders: string[] }): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    const id = req['id'];
    const headers = new Headers();
    // Record whether the client echoed the session id on this request.
    records.sessionHeaders.push(String(new Headers(init?.headers).get('mcp-session-id') ?? ''));

    switch (req['method']) {
      case 'initialize':
        headers.set('content-type', 'application/json');
        headers.set('mcp-session-id', 'sess-123');
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05' } }),
          { headers },
        );
      case 'notifications/initialized':
        return new Response(null, { status: 202 });
      case 'tools/list': {
        headers.set('content-type', 'text/event-stream');
        const body = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, result: { tools: [{ name: 'search', inputSchema: { type: 'object' } }] } })}\n\n`;
        return new Response(body, { headers });
      }
      case 'tools/call':
        headers.set('content-type', 'application/json');
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'text', text: 'ok' }] },
          }),
          { headers },
        );
      default:
        return new Response(null, { status: 202 });
    }
  }) as unknown as typeof fetch;
}

test('http transport round-trips over JSON and SSE and carries the session id', async () => {
  const records = { sessionHeaders: [] as string[] };
  const transport = createHttpTransport({
    fetch: fakeFetch(records),
    url: 'https://mcp.example/sse',
  });
  const client = createMcpClient(transport);

  await client.initialize();
  const tools = await client.listTools(); // SSE path
  assert.equal(tools[0]!.name, 'search');
  const res = await client.callTool('search', { q: 'hi' }); // JSON path
  assert.equal(res.text, 'ok');

  // initialize had no session yet; tools/list and tools/call echoed sess-123.
  assert.equal(records.sessionHeaders[0], '');
  assert.ok(records.sessionHeaders.slice(2).every((h) => h === 'sess-123'));
});

test('a non-2xx response rejects the request with the status', async () => {
  const failing = (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch;
  const transport = createHttpTransport({ fetch: failing, url: 'https://mcp.example/sse' });
  const client = createMcpClient(transport);
  await assert.rejects(() => client.listTools(), /MCP HTTP 401/);
});
