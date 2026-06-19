// Minimal MCP (Model Context Protocol) client — JSON-RPC 2.0, transport-agnostic.
//
// The transport (stdio / streamable-HTTP, in sibling files) owns the bytes; this
// owns the protocol: request/response correlation by id, the initialize
// handshake, and the tools/list + tools/call calls. Deliberately tiny — a few
// hundred lines instead of the official SDK's dependency tree, so the module
// stays Pi-light and core carries nothing.

export interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// Moves single JSON-RPC messages between us and one MCP server. The client calls
// onMessage once at construction to receive server→client traffic, and onClose
// (if provided) so a dropped transport rejects in-flight requests.
export interface McpTransport {
  send(message: JsonRpcMessage): Promise<void>;
  onMessage(handler: (message: JsonRpcMessage) => void): void;
  onClose?(handler: (err?: Error) => void): void;
  close(): Promise<void>;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpClientOptions {
  // Per-request timeout (ms). A server that never answers must not hang a tool
  // call forever. Default 30s.
  requestTimeoutMs?: number;
  clientName?: string;
  clientVersion?: string;
}

export interface McpClient {
  initialize(): Promise<void>;
  listTools(): Promise<McpTool[]>;
  // Returns the flattened text content; isError marks a tool-level failure the
  // caller surfaces to the model rather than throwing.
  callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ text: string; isError: boolean }>;
  close(): Promise<void>;
}

export const MCP_PROTOCOL_VERSION = '2024-11-05';

interface Pending {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function createMcpClient(transport: McpTransport, opts: McpClientOptions = {}): McpClient {
  let nextId = 1;
  let closed = false;
  const pending = new Map<number, Pending>();
  const timeoutMs = opts.requestTimeoutMs ?? 30_000;

  transport.onMessage((msg) => {
    if (!msg || typeof msg !== 'object') return;
    const id = msg.id;
    // Only correlate numbered responses; notifications (no id) and string ids we
    // never issued are ignored.
    if (typeof id !== 'number') return;
    const waiter = pending.get(id);
    if (!waiter) return;
    pending.delete(id);
    clearTimeout(waiter.timer);
    if (msg.error) waiter.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
    else waiter.resolve(msg.result);
  });

  const failAll = (err: Error): void => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
    pending.clear();
  };

  transport.onClose?.((err) => {
    closed = true;
    failAll(err ?? new Error('MCP transport closed'));
  });

  async function request(method: string, params?: unknown): Promise<unknown> {
    if (closed) throw new Error('MCP transport is closed');
    const id = nextId++;
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP request '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      pending.set(id, { resolve, reject, timer });
    });
    await transport.send({
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    });
    return result;
  }

  async function notify(method: string, params?: unknown): Promise<void> {
    if (closed) return;
    await transport.send({
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {}),
    });
  }

  return {
    async initialize() {
      await request('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: {
          name: opts.clientName ?? 'modulus-mcp',
          version: opts.clientVersion ?? '1.0.0',
        },
      });
      // The server is live once it answers initialize; the spec's follow-up
      // notification tells it we're ready for normal traffic.
      await notify('notifications/initialized');
    },

    async listTools() {
      const result = (await request('tools/list', {})) as { tools?: unknown };
      const raw = Array.isArray(result.tools) ? result.tools : [];
      const tools: McpTool[] = [];
      for (const t of raw) {
        if (!t || typeof t !== 'object') continue;
        const rec = t as Record<string, unknown>;
        if (typeof rec['name'] !== 'string') continue;
        const tool: McpTool = { name: rec['name'] };
        if (typeof rec['description'] === 'string') tool.description = rec['description'];
        if (rec['inputSchema'] && typeof rec['inputSchema'] === 'object') {
          tool.inputSchema = rec['inputSchema'] as Record<string, unknown>;
        }
        tools.push(tool);
      }
      return tools;
    },

    async callTool(name, args) {
      const result = (await request('tools/call', { name, arguments: args })) as {
        content?: unknown;
        isError?: unknown;
      };
      const blocks = Array.isArray(result.content) ? result.content : [];
      const text = blocks
        .filter(
          (c): c is { type: string; text: string } =>
            !!c &&
            typeof c === 'object' &&
            (c as Record<string, unknown>)['type'] === 'text' &&
            typeof (c as Record<string, unknown>)['text'] === 'string',
        )
        .map((c) => c.text)
        .join('\n');
      return { text: text || '(no output)', isError: result.isError === true };
    },

    async close() {
      closed = true;
      failAll(new Error('MCP client closed'));
      await transport.close();
    },
  };
}
