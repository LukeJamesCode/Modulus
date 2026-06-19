// modulus-mcp entrypoint. Connects the MCP servers configured in settings and
// registers each of their tools as a Modulus tool named `mcp__<server>__<tool>`.
//
// Zero core changes by design: it uses only the public Host surface —
// host.tools.register (dynamic tools), host.spawn (stdio servers, tripwire-
// guarded), host.fetch (HTTP servers, tripwire-guarded), host.settings, host.log.
//
// Safe by default: an MCP tool is external code over a socket, so every tool is
// confirm-tier unless the owner promotes it via a server's `autoTools` list. A
// write-capable MCP tool therefore fails closed in unattended agent runs until
// explicitly trusted — the existing confirm-fail-closed invariant, for free.

import type { Host } from '../../src/core/modules.js';
import { createMcpClient, type McpClient } from './lib/client.js';
import { createStdioTransport, type StdioChild } from './lib/stdio.js';
import { createHttpTransport } from './lib/http.js';
import { toToolParameters } from './lib/schema.js';

interface ServerConfig {
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  // Tool names promoted from confirm → auto for this server.
  autoTools?: string[];
  // Default true; set false to keep a server's config but not connect it.
  enabled?: boolean;
}

// Per-load state, drained by unregister. One module folder = one instance, so
// module scope is the right home (mirrors how other stateful modules track theirs).
let clients: McpClient[] = [];
let registeredTools: string[] = [];

// A server name must be a safe tool-name segment so `mcp__<server>__<tool>` stays
// parseable and collision-free.
const SERVER_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/i;

function parseServers(raw: string, log: Host['log']): ServerConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw || '[]');
  } catch (e) {
    log.warn('mcp: servers_json is not valid JSON — no servers connected', {
      error: e instanceof Error ? e.message : String(e),
    });
    return [];
  }
  if (!Array.isArray(parsed)) {
    log.warn('mcp: servers_json must be a JSON array');
    return [];
  }
  const out: ServerConfig[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const s = item as Record<string, unknown>;
    const name = String(s['name'] ?? '').trim();
    const transport = s['transport'] === 'http' ? 'http' : 'stdio';
    if (!SERVER_NAME_RE.test(name)) {
      log.warn('mcp: skipping server with a missing/invalid name', { name });
      continue;
    }
    out.push({
      name,
      transport,
      ...(typeof s['command'] === 'string' ? { command: s['command'] } : {}),
      ...(Array.isArray(s['args']) ? { args: s['args'].map((a) => String(a)) } : {}),
      ...(s['env'] && typeof s['env'] === 'object'
        ? { env: s['env'] as Record<string, string> }
        : {}),
      ...(typeof s['url'] === 'string' ? { url: s['url'] } : {}),
      ...(s['headers'] && typeof s['headers'] === 'object'
        ? { headers: s['headers'] as Record<string, string> }
        : {}),
      ...(Array.isArray(s['autoTools']) ? { autoTools: s['autoTools'].map((t) => String(t)) } : {}),
      ...(s['enabled'] === false ? { enabled: false } : {}),
    });
  }
  return out;
}

async function connectServer(host: Host, server: ServerConfig): Promise<void> {
  try {
    let transport;
    if (server.transport === 'http') {
      if (!server.url) throw new Error('http server has no url');
      transport = createHttpTransport({
        fetch: host.fetch,
        url: server.url,
        ...(server.headers ? { headers: server.headers } : {}),
      });
    } else {
      if (!server.command) throw new Error('stdio server has no command');
      const spawn = (
        command: string,
        args: readonly string[],
        options: { env?: NodeJS.ProcessEnv },
      ) => host.spawn(command, args, options) as unknown as StdioChild;
      transport = createStdioTransport({
        spawn,
        command: server.command,
        args: server.args ?? [],
        env: { ...process.env, ...server.env },
        onStderr: (line) => host.log.debug('mcp server stderr', { server: server.name, line }),
      });
    }

    const client = createMcpClient(transport, { clientName: 'modulus-mcp' });
    await client.initialize();
    const tools = await client.listTools();
    clients.push(client);

    const auto = new Set(server.autoTools ?? []);
    for (const t of tools) {
      const toolName = `mcp__${server.name}__${t.name}`;
      const remoteName = t.name;
      host.tools.register({
        name: toolName,
        description: t.description ?? `${remoteName} (provided by the ${server.name} MCP server).`,
        parameters: toToolParameters(t.inputSchema),
        // External code over a socket: confirm-tier unless explicitly promoted.
        tier: auto.has(remoteName) ? 'auto' : 'confirm',
        confirmPrompt: () => `Run ${server.name}'s ${remoteName}?`,
        invoke: async (args) => {
          const res = await client.callTool(remoteName, args);
          return res.isError ? `MCP tool '${remoteName}' returned an error: ${res.text}` : res.text;
        },
      });
      registeredTools.push(toolName);
    }
    host.log.info('mcp server connected', { server: server.name, tools: tools.length });
  } catch (e) {
    // A dead/misconfigured server omits its tools rather than breaking the load.
    host.log.warn('mcp server failed to connect', {
      server: server.name,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

export async function register(host: Host): Promise<void> {
  const raw = host.settings.get<string>('servers_json', '[]') || '[]';
  const servers = parseServers(raw, host.log).filter((s) => s.enabled !== false);
  await Promise.all(servers.map((s) => connectServer(host, s)));
}

export async function unregister(host: Host): Promise<void> {
  for (const name of registeredTools) host.tools.unregister(name);
  registeredTools = [];
  const toClose = clients;
  clients = [];
  for (const c of toClose) {
    try {
      await c.close();
    } catch {
      /* ignore — we're tearing down */
    }
  }
}
