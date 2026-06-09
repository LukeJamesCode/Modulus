# HANDOFF — Modulus implementation (for Opus 4.8)

You are picking up the Modulus build mid-flight. This document is self-contained: it tells you
what Modulus is, what is already built and verified in this repo, and exactly what to do next.
Read [docs/blueprint.md](docs/blueprint.md) (the full approved architecture) and
[CLAUDE.md](CLAUDE.md) (North Stars + working rules) before writing code.

## Context in three sentences

Modulus is the everyday-person evolution of Gurney (a Telegram-first, CPU-only local AI agent
that lives in `../GurneyAgent/`): same engine, plus an integrated web UI, a curated module
Marketplace, module-shipped specialist agents, and one hive-mind memory shared by every agent.
This repo was bootstrapped fresh from Gurney's core (renamed `gurney`→`modulus` throughout) and
the four hardest core features have already been built and tested. Your job is the remaining
phases: panel-into-core, instant responses, the marketplace UI/registry wiring, module
migration, and polish.

## Decisions already made with the maintainer (do not relitigate)

1. **Fresh repo** (this one) — Gurney lives on separately; no backwards compatibility needed.
2. **In-process UI** — the daemon itself serves the panel (today it still spawns a separate
   panel process — changing that is YOUR Phase 1).
3. **Curated registry** — first-party modules only in V1, sha256-pinned tarballs on GitHub
   Releases, consent screens, re-consent on permission growth.
4. **Hive memory = SQLite FTS5** (built). Embeddings are V2; memgraph stays an optional module.
5. **Migrations were NOT squashed** (deliberate deviation from the blueprint §1): the 20
   inherited migrations are tested and working; new ones continue from 0023.
6. V1 module names: `modulus-browser, -codex, -discord, -assistant, -minimax, -openai,
-voice, -websearch`.

## What is ALREADY BUILT in this repo (verified: 384 tests, 381 pass / 3 POSIX-only skips)

| Feature                                  | Where                                                                                                                                                                                       | Commit-tested behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hive-mind memory**                     | `src/core/memory.ts`, migration `0021_memories.sql`, [memory.test.ts](src/core/memory.test.ts)                                                                                              | FTS5/BM25 recall injected into the deterministic prompt prefix for the main chat AND every per-agent orchestrator (`memoryProvider` in `src/core/orchestrator.ts` + `src/core/agents.ts`, wired in `src/cli/start.ts`). `remember` (auto) / `forget` (confirm, fails closed) core tools. Agent `record_finding` notes auto-promote to shared memory on task completion (`onTaskDone` in start.ts). Importance-aware eviction, dedup, FTS-injection-safe. |
| **Module-provided agents** (manifest v2) | `src/core/extensions.ts` (`ManifestAgent`, `AgentFleetRegistrar`, `syncManifestAgents`), migration `0022_agent_origin.sql`, [extensions.agents.test.ts](src/core/extensions.agents.test.ts) | A module manifest may declare `agents: [...]`; the loader upserts them into the fleet with `origin: 'ext:<name>'` (stable ids across reloads — task history survives upgrades), refuses to hijack user-created agents by name, removes them on uninstall/disable, sweeps orphans at startup. Default grant scopes a module agent to its own module's tools.                                                                                              |
| **Secure installer core**                | `src/core/installer.ts`, [installer.test.ts](src/core/installer.test.ts)                                                                                                                    | The full pipeline minus UI: index parsing (https-only, sha256-pinned, validated), capped download, sha verify BEFORE unpack, strict ustar extraction (hard-errors on symlinks/hardlinks/pax/zip-slip/absolute paths), manifest-identity check against the index entry, stage→consent→commit flow, `permissionDiff()` for re-consent, `describePermissions()` plain-language consent lines.                                                               |
| **Fleet manifest injection**             | Already existed in Gurney: `delegateRosterPrompt()` in `src/core/agents.ts`                                                                                                                 | Delegating agents get a one-line-per-specialist roster in their system prompt, cache-invalidated on roster change. Module-provided agents appear in it automatically. **Do not rebuild this.**                                                                                                                                                                                                                                                           |
| **Repo bootstrap**                       | everything                                                                                                                                                                                  | Renames done (`modulus` binary, `MODULUS_` env vars, `~/.modulus/`, `modulus.db`); CI workflows copied; lint/typecheck/format/test all green.                                                                                                                                                                                                                                                                                                            |

Multi-agent engine, autonomous loop, resource governor, Telegram adapter, scheduler, tool
tiers, secret redaction — all inherited from Gurney intact. `docs/` in `../GurneyAgent/`
documents them (esp. `05-multi-agent.md`).

## Environment warnings (Windows dev box)

- **Do not delete `node_modules`.** better-sqlite3 has no prebuilt binary for this Node
  (20.20.0/win32) and there is no C++ toolchain; `node_modules` was copied from
  `../GurneyAgent/node_modules`. If you must reinstall, copy
  `../GurneyAgent/node_modules/better-sqlite3` back over.
- Tests: `npm test` (all) or `node --import tsx --test src/path/foo.test.ts` (one).
- 3 skipped tests are POSIX file-mode checks — expected on Windows, not a failure.

## YOUR WORK — in this order

### Phase 1 — Panel into core (the big one)

Today: the panel is `extensions/gurney-frontend` in the GURNEY repo (a 128 KB `server.ts` +
`web/*.jsx`), and this repo's `src/cli/start.ts` still **spawns it as a separate process**
(`spawnPanel` / `src/cli/panel.ts` / `frontend.ts`). Replace that:

1. Copy `../GurneyAgent/extensions/gurney-frontend/web/*` → `src/panel/web/` — EXCEPT
   `history.jsx` (History tab is removed) and `learnhub.jsx` (V2 Tutor). Rename gurney→modulus
   inside, same case rules as the rest of the repo.
2. Split `../GurneyAgent/extensions/gurney-frontend/server.ts` (its `handleApi()` is a 37-edge
   god function) into `src/panel/server.ts` (bootstrap: bind, auth, static, SSE) +
   `src/panel/routes/{chat,agents,modules,settings,system}.ts`. Mechanical extraction along the
   URL families — same handlers, no behaviour change beyond what's listed here.
3. Start it **in-process** from `start.ts` behind core settings `panel.enabled` (default true),
   `panel.port`, `panel.bind` (default `127.0.0.1`). Delete `src/cli/panel.ts`,
   `src/cli/frontend.ts`, `spawnPanel`, `frontendExtensionEnabled`, and `modulus logs --panel`.
4. Auth: generate a bearer token at first run (store in `~/.modulus/`, print via
   `modulus status`); require `Authorization: Bearer` on every mutating endpoint
   (constant-time compare); CSP headers on the HTML; SSE endpoints token-gated too.
5. Being in-process, the agents run view can subscribe directly to
   `agentRuntime.subscribe(taskId, fn)` for live SSE instead of polling checkpointed DB state.
6. Five tabs: Dashboard (chat), Agents, Modules, Settings, System. Theme: near-black/gray
   surfaces, purple→pink gradient accents (centralize CSS variables; e.g.
   `--accent-grad: linear-gradient(135deg,#8b5cf6,#ec4899)`), DNA-helix inline SVG logo.
7. Settings tab gets: a **memory browser** (list/search/delete over the existing
   `MemoryStore.list/remove` — the store is already wired in start.ts) and the
   instant-responses toggle (Phase 2).

_Done when:_ `modulus start` serves the UI on localhost; chat round-trips through the same
orchestrator as Telegram; a run view updates live without DB polling; unauthenticated mutating
requests are rejected; History/LearnHub are gone; route modules have unit tests.

### Phase 2 — Instant Responses in core

Port the logic of `../GurneyAgent/extensions/gurney-instant-responses/commands.ts` into the
chat dispatch path behind a core setting `instantResponses.enabled` (default on, toggle in
Settings). Ack immediately from a canned-phrase pool (NO model call for the ack) when a turn is
predicted slow (heavy profile, delegation, autonomous escalation); the real answer streams/edits
after. Test the Telegram edit path and the panel SSE path; no double-reply races.

### Phase 3 — Finish the module rename + main-chat delegation

1. Rename remaining `extension`→`module` identifiers (loader, tables via NEW migrations that
   rename `extension_state`→`module_state` etc., CLI `modulus mod …`, UI copy,
   `~/.modulus/modules/`). Keep it mechanical; update tests.
2. **Main-chat delegation gap (important):** `start.ts` currently FILTERS
   `spawn_agent`/`spawn_agents` out of the main chat's tool registry (`chatTools`). The
   blueprint's Modulus Agent answer: keep the main chat lean, and route big asks to the agent
   queue. Implement the escalation: when the user asks for long-horizon work, the main chat
   enqueues a task for the seeded `operator` agent (the autonomous flagship) and tells the user
   where to watch it (Agents tab) — pair with Instant Responses. The seeded fleet + roster
   prompt already exist; you are wiring main-chat → queue, not building delegation.
3. Spec the **memory extraction job** (deliberately left for you): after a user-facing turn, a
   background-queue job asks the SMALL model to extract 0–2 durable facts from the turn and
   calls `memory.remember({source:'extraction'})`. User reply ships first (the queue already
   guarantees this). Keep the prompt tiny; dedup is free at the store.

### Phase 4 — Marketplace UI + registry

1. Create the `modulus-registry` GitHub repo: `index.json` (schema = `RegistryIndexEntry` in
   `src/core/installer.ts`) + a CI job that packs each module folder into a `.tgz` (plain
   ustar — the strict extractor rejects pax/gnu long-name entries; keep module paths short),
   computes sha256, attaches to a GitHub Release, and updates index.json.
2. Panel Modules tab: browse (fetch index, cache briefly), Install → consent screen rendered
   from `describePermissions()` → `stageModule`/`commitModule` → hot-load via
   `loader.reload(name)`. Update flow uses `permissionDiff()` — any addition forces re-consent.
   Uninstall = remove folder + `loader.unload` (module agents clean themselves up — built).
3. CLI parity: `modulus mod install <name|url|path>` shares the same installer
   (`src/core/installer.ts`), replacing the git-clone path from Gurney's `src/cli/ext.ts` for
   registry names (keep local-folder installs for developers).
4. `MODULUS_REGISTRY_URL` env override; default points at the modulus-registry raw index.

### Phase 5 — Migrate the 8 V1 modules

From `../GurneyAgent/extensions/`: browser, codex, discord, everyday-assistant→assistant,
minimax, openai-compatible→openai, voice, websearch. For each: rename, manifest v2 (honest
`permissions` block, `version`), declare agents where it makes sense (codex→`coder` (reason),
websearch→`researcher` (tools), browser→`browser-operator`), smoke tests, publish to the
registry. NOT migrated: tudor (V2), frontend (became core), instant-responses (became core).

### Phase 6 — Power Mode + polish

1. **Power Mode**: make `modulus-openai` a first-class, tested configuration — point any
   profile at an OpenAI-compatible endpoint from Settings; integration tests for profile
   routing/streaming/tool calls. This is the "as smart as the big guys" toggle and the answer
   to OpenClaw/Hermes-class capability.
2. Onboarding wizard in the panel (first run: Telegram token, model pull, tier detect — reuse
   wizard.jsx), README/docs/CHANGELOG, `npx modulus` install story.

### Phase 7 (LAST) — Eval harness

Port `../GurneyAgent/extensions/gurney-abilitytest`. **It is outdated** (predates the agent
engine and manifest v2) — expect rework, not a copy. Target: one command produces a scorecard
on (a) tool-selection accuracy, (b) delegation correctness, (c) end-to-end task success, on
both the Pi profile and Power Mode; deterministic (FakeLLM) subset runs in CI.

## Working rules that bit me (so they don't bite you)

- `node_modules` warning above is real — typecheck/test before any dependency surgery.
- The deterministic prompt prefix (system → tools → memory → session → history) is a North
  Star; anything you add to the prompt must go in a stable slot (see `memoryProvider` for the
  pattern).
- Confirm-tier tools fail closed in unattended runs — never "fix" that.
- Match the repo's comment style: comments say WHY, never narrate the diff.
- After each phase: `npm run lint && npx tsc --noEmit && npm test` green, then commit (terse,
  imperative, why-not-what).
