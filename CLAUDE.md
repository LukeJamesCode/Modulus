# Modulus

**Current version: 1.5.3** — SemVer; the canonical value lives in `package.json` and is read
into `HOST_VERSION` (`src/core/version.ts`). Bump it on every change (see Versioning below).

Local AI orchestrator for everyday people (evolved from Gurney, `../GurneyAgent/`). One Node
daemon = Telegram bot + agent engine + web panel + scheduler; Ollama is the only separate
process, never bundled. The 1.0.0 release shipped the in-process panel, marketplace, Power
Mode, instant responses, and the 8 first-party modules; the line has since advanced through the
1.5.x series (CHANGELOG.md is the running record). HANDOFF.md is a historical build log — never
take task lists or "what exists" claims from it; the code is the source of truth.

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

- Deterministic prompt prefix — system → tools → session → history — protects the Ollama KV
  cache. Per-turn VOLATILE context (the clock anchor + recalled memory) rides a system message
  at the TAIL, right before the latest user turn (`turnContext`/`memory` in
  `src/core/context.ts`), so it never invalidates the cached prefix — system+tools+history then
  reuse their KV across a focused multi-turn conversation. New STABLE prompt content goes in a
  prefix slot; new PER-TURN content goes in the tail. Pruned tool schemas are name-sorted so a
  repeated intent yields a byte-identical tool block (same cache reason).
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

## Versioning

SemVer (`MAJOR.MINOR.PATCH`), Keep-a-Changelog. The **single source of truth is
`package.json`'s `version`** — `src/core/version.ts` reads it into `HOST_VERSION`, and the panel
`/api/state` report plus the registry `minCoreVersion` gate derive from it, so they never drift.
Never hardcode the version anywhere else.

- **Bump on every change.** Any shippable edit to `src/`, `modules/`, or `desktop/` bumps the
  version in the same commit: PATCH for fixes/internals, MINOR for a user-facing feature, MAJOR
  for a breaking change or a broken invariant. Comment-/docs-only edits don't need a bump.
- **Three places move together, every bump:** (1) `package.json` `version`, (2) the
  `**Current version:**` line at the top of this file, (3) a `CHANGELOG.md` entry — under
  `[Unreleased]` while in flight, promoted to a dated `[x.y.z] - YYYY-MM-DD` section when shipped.
- The desktop installer version (`MODULUS_DESKTOP_VERSION`) must match the same number and stay
  ahead of the latest in `desktop/Releases`, or vpk aborts (see the desktop section below).
- bug fix example 1.5.1 to 1.5.11
- small feature added example 1.5.1 to 1.5.2
- bug feature or multifeature example 1.5.1 to 1.6.0
## This dev box (Windows)

NEVER delete `node_modules` or reinstall from scratch: better-sqlite3 has no prebuilt binary
for this Node (20.x/win32) and the machine has no C++ toolchain — `node_modules` was copied
from GurneyAgent. If it breaks, restore `node_modules/better-sqlite3` from
`../GurneyAgent/node_modules/`.

## Keep the desktop build in sync

After any `src/` change that should reach the desktop app, republish the daemon so the
WinUI shell (`desktop/publish/`) actually runs the new code — the shell launches
`desktop/publish/daemon/app/dist/cli/index.js`, and a stale `dist/` is the default trap.
Once the gate is green:

1. `rm -rf dist && npm run build` — clean, because `tsc` does NOT prune orphan `.js` for
   deleted sources (it leaves e.g. `dist/core/workflow-runner.js` behind).
2. `cpSync` the fresh `dist/` over both `desktop/staging/daemon/app/dist` and
   `desktop/publish/daemon/app/dist` (one Node `cpSync` per dest; `rm -rf` the dest first).

That is the every-time step (no C#/dep change ⇒ no shell rebuild). Only when a distributable
`Setup.exe` is needed, run the full pipeline: `MODULUS_DESKTOP_VERSION=<next>
node desktop/scripts/build-installer.mjs` (re-stages with `npm ci` in `staging/` — never the
repo `node_modules` — then `dotnet publish` + `vpk pack`). Bump the version past the latest in
`desktop/Releases` or vpk aborts ("release ≥ current version"). The build also wipes/regenerates
`desktop/publish/`, so it fails with `EBUSY` unless ModulusDesktop is closed first — fully quit
it and free port 7787 before building or relaunching, else the new launch adopts the stale daemon.
