# modulus-mcp

Connect **Model Context Protocol (MCP)** servers to Modulus and use their tools in
chat and agent runs. MCP is the de-facto standard for plugging external
capabilities into an assistant — filesystems, GitHub, databases, search, browser
automation, and hundreds more — and this module bridges any MCP server's tools
into the Modulus tool registry with no code of your own.

Each server's tools appear as `mcp__<server>__<tool>`. New tools are **confirm-tier**
(you approve each run) until you promote trusted ones to automatic.

## How it works

The module speaks MCP's JSON-RPC 2.0 to each server you configure, over either
transport:

- **stdio** — Modulus launches the server as a child process (through the module's
  tripwire-guarded `spawn`) and talks to it over stdin/stdout. This is how most
  local servers ship (`npx @modelcontextprotocol/server-…`).
- **http** — Modulus POSTs to the server's URL (through the tripwire-guarded
  `fetch`), handling both plain-JSON and `text/event-stream` (SSE) responses and
  the session id.

On load it connects every enabled server, lists its tools, and registers each one.
A server that fails to connect just omits its tools — it never breaks the rest.

## Configuration

In **Modules → modulus-mcp → Settings**, set `servers_json` to a JSON array of
servers. A local (stdio) server and a remote (http) server:

```json
[
  {
    "name": "filesystem",
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/me/data"],
    "autoTools": []
  },
  {
    "name": "github",
    "transport": "http",
    "url": "https://mcp.example.com/sse",
    "headers": { "Authorization": "Bearer ghp_…" },
    "autoTools": ["search_issues"]
  }
]
```

Fields: `name` (a short id, used in the tool name), `transport` (`stdio` | `http`),
`command`/`args`/`env` (stdio), `url`/`headers` (http), `autoTools` (tool names that
may run without asking), and `enabled: false` to keep a server configured but
dormant. Toggle the module off/on (or reload it) to apply changes.

## Safe by default

An MCP server is external code, so **every tool it exposes is confirm-tier**: in
chat you get a Yes/No prompt before each call, and in an **unattended agent run a
confirm-tier tool fails closed** unless you explicitly trusted it. Promote a
specific tool to automatic by adding its name to that server's `autoTools`.

The module declares broad `network`/`subprocess` permissions because *you* choose
which servers and binaries it runs — the per-server config in settings is the real
control surface. Calls still flow through the module tripwire, so a server that
tries to reach somewhere unexpected is counted in `/status` and the System tab.
Only the owner can change settings.

## Limits (v1)

- The HTTP transport targets request/response servers; a server that holds an SSE
  stream open indefinitely is bounded by the per-request timeout.
- MCP **resources** and **prompts** are not surfaced yet — only **tools**.
- Server config is a JSON string (the settings store holds primitives); a richer
  per-server editor is a future enhancement.
