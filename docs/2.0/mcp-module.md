# 2.0.0 Plan 3 — MCP module (`modulus-mcp`)

A first-party module that connects to **Model Context Protocol** servers and
exposes their tools as Modulus tools. MCP is the de-facto standard for plugging
external capabilities into agents; one module opens the whole ecosystem.

**North-Star target: zero core changes.** The Host surface already exposes
everything this needs — `host.tools.register` (dynamic tool registration),
`host.spawn` (tripwire-guarded subprocess for stdio servers), `host.fetch`
(tripwire-guarded HTTP for remote servers), per-module `settings`, and per-module
`node_modules` (migration 0025). If a core change turns out unavoidable, **stop
and treat it as a Host API gap** — name the missing method in the plan rather than
patching core, because a module needing a core change means the module API failed
(North Star #3).

This plan is disjoint from Plans 1, 2, 4 — it's a new folder under `modules/`.

## Why a hand-rolled client (Pi-first)

MCP is JSON-RPC 2.0 over a transport (stdio or streamable-HTTP/SSE). The official
`@modelcontextprotocol/sdk` pulls a non-trivial dependency tree. For the CPU-only/
Pi target we implement a **minimal client** ourselves — `initialize`,
`tools/list`, `tools/call`, and notifications — which is a few hundred lines and
keeps core _and_ the module lean. The SDK stays a documented alternative for users
who enable it; if used, it installs into the module's own `node_modules` on enable,
never core (North Star #2).

## Module layout

```
modules/modulus-mcp/
  manifest.json          # capabilities: network, subprocess, storage
  tools.ts               # entrypoint: read settings → connect servers → register tools
  lib/
    client.ts            # MCP JSON-RPC client (initialize / tools.list / tools.call)
    stdio.ts             # stdio transport via host.spawn
    http.ts              # streamable-HTTP + SSE transport via host.fetch
    schema.ts            # map MCP tool inputSchema (JSON Schema) → ToolHandler.parameters
    schema.test.ts
    client.test.ts
  settings.schema.json   # the server list + per-tool auto allowlist
  README.md
  tools.test.ts
```

## Configuration (per-module settings, no core change)

`settings.schema.json` holds a `servers` array; the user edits it in the panel
module settings (the same surface every module already uses):

```jsonc
{
  "servers": [
    {
      "name": "filesystem",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data"],
      "autoTools": [], // names promoted from confirm → auto
    },
    {
      "name": "github",
      "transport": "http",
      "url": "https://mcp.example.com/sse",
      "headers": { "Authorization": "Bearer …" },
      "autoTools": ["search_issues"],
    },
  ],
}
```

## Tool registration

On `register(host)` (and on reload), `tools.ts`:

1. Reads `host.settings` → the `servers` list.
2. For each enabled server, opens the transport and runs `initialize` then
   `tools/list`.
3. For each remote tool, registers a Modulus tool named `mcp__<server>__<tool>`
   whose `parameters` are mapped from the MCP `inputSchema` (`lib/schema.ts`) and
   whose `invoke` proxies to `tools/call`, returning the text content blocks as the
   tool result.
4. On `unregister`/unload: unregister every `mcp__*` tool and close transports.

Connection failures are logged and surfaced (`/status` denied-counter style); a
dead server just omits its tools rather than breaking load. Settings changes
reconnect (toggle the module, or a settings-changed re-register).

## Safe by default (tiers)

External MCP tools are unknown code over a socket, so **every MCP tool defaults to
`confirm` tier**. A per-server `autoTools` allowlist promotes named, vetted tools
to `auto`. Consequence: a write-capable MCP tool **fails closed in unattended
agent runs** unless the owner explicitly promoted it — the existing
confirm-fail-closed invariant, for free. The consent screen (from the manifest
`capabilities`/`permissions`) tells the truth: "can run programs you configure as
MCP servers" / "can contact the servers you configure."

### Permissions honesty note

A static `manifest.json` can't enumerate the user's chosen server binaries/URLs
ahead of time. v1 declares the **capabilities** (`subprocess`, `network`) and
documents that the per-server config in settings is the real control surface; the
tripwire still enforces `host.spawn`/`host.fetch` against the manifest allowlist.
A cleaner future option — letting a module declare _dynamic_ permissions sourced
from its settings — is a genuine Host gap; record it, don't block v1 on it.

## Tests (`modules/tsconfig.json`; `npm run typecheck:modules`)

- `schema.test.ts` — MCP `inputSchema` → `ToolHandler.parameters` mapping
  (objects, required, enums, nested).
- `client.test.ts` — JSON-RPC framing for `initialize`/`tools.list`/`tools.call`
  against a fake in-memory transport; error responses surface as tool errors.
- `tools.test.ts` — a fake stdio server (a tiny echo over a pipe) registers its
  tools; a call round-trips; `autoTools` promotes tier; unload unregisters and
  closes. Copy the nearest module test's harness.

## Phases

- **A.** `lib/client.ts` + `lib/schema.ts` + their tests (pure, fake transport).
- **B.** `lib/stdio.ts` via `host.spawn` + fake-server round-trip test.
- **C.** `lib/http.ts` via `host.fetch` (streamable-HTTP + SSE) + test.
- **D.** `tools.ts` entrypoint (settings → connect → register), `settings.schema.json`,
  `manifest.json`, tier defaulting, unload cleanup + test. **Verify zero `src/`
  edits were needed** — the acceptance gate for North Star #3.
- **E.** `README.md`, `registry.md` entry (sha256 filled when packed), publish to
  the registry alongside the other first-party modules (a later release step).

## Success criteria

- Dropping `modulus-mcp` into `~/.modulus/modules/` and configuring one stdio and
  one HTTP server surfaces their tools in chat — **with no change to `src/`**.
- An unpromoted MCP tool prompts for confirmation interactively and fails closed in
  an unattended agent run; a tool in `autoTools` runs automatically.
- A non-allowlisted host/binary reached by a misconfigured server trips the module
  tripwire (counted in `/status`), keeping the consent screen truthful.

## Status (implemented — Phases A–E)

**Done, full gate green** (994 tests, 991 pass / 3 skips; `typecheck:modules` clean)
and — the acceptance gate — **zero `src/` edits**. The whole module lives under
`modules/modulus-mcp/`:

- `lib/client.ts` (MCP JSON-RPC client) + `lib/schema.ts` (inputSchema →
  parameters), 14 tests; `lib/stdio.ts` (`host.spawn`) + `lib/http.ts`
  (`host.fetch`, JSON + SSE + session id), 4 tests; `tools.ts` entrypoint
  (settings → connect → register `mcp__<server>__<tool>`, confirm-tier default with
  `autoTools` promotion, unload cleanup), 3 tests. `manifest.json` (broad
  `network`/`subprocess` permissions, honest per the note above),
  `settings.schema.json` (`servers_json`), `README.md`.
- Settings reality: the per-module store holds primitives, so the server list is a
  JSON **string** (`servers_json`) the module parses — not a nested object.
- v1 surfaces MCP **tools** only (not resources/prompts); the HTTP transport targets
  request/response servers (bounded by the per-request timeout).

**Remaining (release steps, not code):** pack + sha256 + add to the
`modulus-registry` index, and a live end-to-end smoke against a real MCP server
(e.g. `@modelcontextprotocol/server-filesystem`). No desktop dist re-sync needed —
this is a new `modules/` folder, not a `src/`/`dist/` change; it reaches a
distributable only through the full installer pipeline.
