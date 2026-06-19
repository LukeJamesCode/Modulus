// Streamable-HTTP transport for the MCP client. Each JSON-RPC message is POSTed
// to the server's single endpoint (through host.fetch, so the module tripwire
// enforces the network allowlist). The server answers either with a plain JSON
// body (one response) or a text/event-stream of `data:` JSON-RPC messages; both
// are delivered to the client. The server's session id (returned on initialize)
// is captured and echoed on later requests.
//
// Minimal by design: it targets request/response servers (initialize, tools/list,
// tools/call). The per-message read is bounded by timeoutMs so a server that
// holds an event-stream open can't hang a call forever.

import type { JsonRpcMessage, McpTransport } from './client.js';

export interface HttpTransportOptions {
  fetch: typeof fetch;
  url: string;
  // Static headers (e.g. Authorization) sent on every request.
  headers?: Record<string, string>;
  // Per-message network timeout (ms). Default 30s.
  timeoutMs?: number;
}

export function createHttpTransport(opts: HttpTransportOptions): McpTransport {
  let onMsg: ((m: JsonRpcMessage) => void) | undefined;
  let sessionId: string | undefined;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  const deliver = (data: unknown): void => {
    if (Array.isArray(data)) {
      for (const m of data) if (m && typeof m === 'object') onMsg?.(m as JsonRpcMessage);
    } else if (data && typeof data === 'object') {
      onMsg?.(data as JsonRpcMessage);
    }
  };

  // Parse an SSE body into its `data:` JSON-RPC payloads.
  const deliverEventStream = (text: string): void => {
    for (const line of text.split(/\r?\n/)) {
      const match = /^data:\s?(.*)$/.exec(line);
      if (!match) continue;
      const payload = (match[1] ?? '').trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        deliver(JSON.parse(payload));
      } catch {
        /* a non-JSON data line is not ours; skip it */
      }
    }
  };

  return {
    send: async (message) => {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(opts.headers ?? {}),
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      };
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      try {
        const res = await opts.fetch(opts.url, {
          method: 'POST',
          headers,
          body: JSON.stringify(message),
          signal: ctrl.signal,
        });
        // Capture the session id from initialize (or any) response.
        const sid = res.headers.get('mcp-session-id');
        if (sid) sessionId = sid;

        if (res.status === 202) return; // notification ack — no body
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`MCP HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
        }
        const contentType = res.headers.get('content-type') ?? '';
        const text = await res.text();
        if (contentType.includes('text/event-stream')) deliverEventStream(text);
        else if (text.trim()) deliver(JSON.parse(text));
      } finally {
        clearTimeout(timer);
      }
    },
    onMessage: (h) => {
      onMsg = h;
    },
    // Stateless POSTs — nothing persistent to tear down.
    close: async () => {},
  };
}
