import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createMcpClient, type JsonRpcMessage, type McpTransport } from './client.js';

// A fake transport that auto-answers requests from a responder map. It records
// every sent message and, for any request (has an id), delivers the responder's
// result (or error) back through onMessage on the next microtask.
function fakeTransport(responder: (method: string, params: unknown) => Partial<JsonRpcMessage>) {
  let handler: ((m: JsonRpcMessage) => void) | undefined;
  const sent: JsonRpcMessage[] = [];
  const transport: McpTransport = {
    send: async (msg) => {
      sent.push(msg);
      if (typeof msg.id === 'number' && msg.method) {
        const reply = responder(msg.method, msg.params);
        const id = msg.id;
        queueMicrotask(() => handler?.({ jsonrpc: '2.0', id, ...reply }));
      }
    },
    onMessage: (h) => {
      handler = h;
    },
    close: async () => {},
  };
  return { transport, sent };
}

test('initialize handshakes then sends the initialized notification', async () => {
  const { transport, sent } = fakeTransport((method) =>
    method === 'initialize'
      ? { result: { protocolVersion: '2024-11-05', serverInfo: { name: 's' } } }
      : { result: {} },
  );
  const client = createMcpClient(transport, { clientName: 'modulus-mcp' });
  await client.initialize();

  assert.equal(sent[0]!.method, 'initialize');
  const params = sent[0]!.params as { clientInfo: { name: string } };
  assert.equal(params.clientInfo.name, 'modulus-mcp');
  // The follow-up notification has no id (it's not a request).
  assert.equal(sent[1]!.method, 'notifications/initialized');
  assert.equal(sent[1]!.id, undefined);
});

test('listTools maps name/description/inputSchema and skips malformed entries', async () => {
  const { transport } = fakeTransport(() => ({
    result: {
      tools: [
        { name: 'read_file', description: 'reads', inputSchema: { type: 'object' } },
        { description: 'no name — dropped' },
        { name: 'noschema' },
      ],
    },
  }));
  const client = createMcpClient(transport);
  const tools = await client.listTools();
  assert.equal(tools.length, 2);
  assert.equal(tools[0]!.name, 'read_file');
  assert.deepEqual(tools[0]!.inputSchema, { type: 'object' });
  assert.equal(tools[1]!.name, 'noschema');
  assert.equal(tools[1]!.inputSchema, undefined);
});

test('callTool flattens text content blocks and passes arguments', async () => {
  let seenParams: unknown;
  const { transport } = fakeTransport((method, params) => {
    if (method === 'tools/call') {
      seenParams = params;
      return {
        result: {
          content: [
            { type: 'text', text: 'hello' },
            { type: 'image' },
            { type: 'text', text: 'world' },
          ],
        },
      };
    }
    return { result: {} };
  });
  const client = createMcpClient(transport);
  const res = await client.callTool('echo', { msg: 'hi' });
  assert.equal(res.text, 'hello\nworld');
  assert.equal(res.isError, false);
  assert.deepEqual(seenParams, { name: 'echo', arguments: { msg: 'hi' } });
});

test('callTool surfaces a tool-level isError result without throwing', async () => {
  const { transport } = fakeTransport(() => ({
    result: { isError: true, content: [{ type: 'text', text: 'boom' }] },
  }));
  const client = createMcpClient(transport);
  const res = await client.callTool('fail', {});
  assert.equal(res.isError, true);
  assert.equal(res.text, 'boom');
});

test('a JSON-RPC error response rejects the request', async () => {
  const { transport } = fakeTransport(() => ({
    error: { code: -32601, message: 'Method not found' },
  }));
  const client = createMcpClient(transport);
  await assert.rejects(() => client.listTools(), /MCP error -32601: Method not found/);
});

test('a request after close rejects', async () => {
  const { transport } = fakeTransport(() => ({ result: {} }));
  const client = createMcpClient(transport);
  await client.close();
  await assert.rejects(() => client.listTools(), /closed/);
});
