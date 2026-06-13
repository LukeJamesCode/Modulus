# Modulus

Local AI orchestrator for everyday people (evolved from Gurney, `../GurneyAgent/`). One Node
daemon = Telegram bot + agent engine + web panel + scheduler; Ollama is the only separate
process, never bundled. v1.0.0 shipped: in-process panel, marketplace, Power Mode, instant
responses, and the 8 first-party modules all exist. HANDOFF.md is a historical build log —
never take task lists or "what exists" claims from it; the code is the source of truth.

Settled design lives in `docs/`: blueprint.md (architecture), registry.md, power-mode.md,
memory-extraction.md. Consult these for design questions instead of re-deriving — the
decisions there are final.

## North Stars (tiebreakers, in order)

1. **An everyday person can run it.** Install, onboard, add modules, chat — no terminal needed.
2. **Runs on CPU-only, GPU optional.** Anything heavier is an opt-in module, never core; heavy npm
   deps install into the module's own folder on enable, core package.json stays lean.
3. **Modules are mods.** A dropped-in folder adds tools, commands, and agents with zero core
   changes. If a module needs a core change, the module API has failed — fix the API.
4. **One process.** New surfaces and servers live inside the daemon, not as sidecars.
5. **Safe by default.** Localhost-only token-auth panel, curated sha256-pinned registry,
   consent screens, confirm-tier tools fail closed unattended.

## Map

- `src/core/` — engine: orchestrator, agent queue + delegation, FTS5 hive memory, module
  loader, installer + registry, LLM router, tools, scheduler
- `src/panel/` — in-process web UI: server.ts, routes/ (chat, agents, marketplace, modules,
  settings, system), web/ assets
- `src/adapters/` — Telegram · `src/cli/` — commander commands · `src/storage/migrations/` —
  append-only numbered SQL
- `modules/` — first-party modules; separate tsconfig → `npm run typecheck:modules`
- `dist/` is build output (tsc + copied migrations/web) — only ever edit `src/`

## Invariants (do not break)

- Deterministic prompt prefix — system → tools → memory → session → history — protects the
  Ollama KV cache. New prompt content goes in a stable slot; copy the `memoryProvider`
  pattern in `src/core/orchestrator.ts`.
- One heavy model resident at a time; the agent queue's resource governor owns residency.
- The user-facing reply ships first; everything else (memory extraction, promotions) runs as
  a background-queue job.
- Delegation: worker grant = supervisor grant ∩ worker allowlist, depth-capped. Confirm/owner
  tools fail closed in unattended runs — never "fix" that.
- Migrations: add a new numbered file continuing the sequence; never edit a shipped one,
  never add-column-if-missing.
- No hardcoded timezones, IPs, or absolute paths. Identifiers say "module" — "extension"
  survives only in shipped migrations and back-compat CLI aliases.

## Build, test, verify

- TypeScript strict, ESM, Node ≥20. better-sqlite3, grammY, commander; Ollama over HTTP only.
- Iterate on the one file you're touching: `node --import tsx --test src/path/foo.test.ts`.
  Run the full gate once at the end: `npm run lint && npm run typecheck && npm test` — all
  green before any commit. `npm test` walks `src/` and `modules/`; a few POSIX file-mode
  tests skip on Windows, which is expected.
- Tests sit beside sources as `*.test.ts` on node:test with FakeLLM + temp SQLite — copy the
  nearest neighbor test's setup instead of inventing a new harness.
- Match the nearest existing pattern; smallest diff that solves the task — no speculative
  abstractions, config options, or wrappers nobody asked for. Comments say WHY only (never
  narrate the diff); commits are terse, imperative, why-not-what.

## This dev box (Windows)

NEVER delete `node_modules` or reinstall from scratch: better-sqlite3 has no prebuilt binary
for this Node (20.x/win32) and the machine has no C++ toolchain — `node_modules` was copied
from GurneyAgent. If it breaks, restore `node_modules/better-sqlite3` from
`../GurneyAgent/node_modules/`.
