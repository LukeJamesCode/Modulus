# Modulus — System Catalogue & Architecture Graph

A complete inventory of every system in Modulus (core, panel, adapters, storage,
CLI, scheduling, and the shipped modules) and how they connect. The second half
is a ready-to-paste prompt for **Claude Opus 4.8** that builds an interactive,
clickable tree-graph HTML artifact from this catalogue.

> Source of truth: the code in `src/` and `modules/`, cross-checked against
> `docs/blueprint.md`. Everything below was read out of the repo, not HANDOFF.md.

---

## 1. The one-process model

Modulus is **one Node daemon**. Ollama is the only separate process (HTTP only,
never bundled). Inside the daemon, four surfaces and the engine all share memory:

```
Telegram ─┐
Discord  ─┤
Panel/Web├─► chat-dispatch ─► orchestrator ─► LLM router ─► Ollama (HTTP)
CLI      ─┘                       │
                                  ├─► tool engine ─► (core tools + module tools)
                                  ├─► context manager (deterministic prefix)
                                  ├─► agent engine + agent queue (governor)
                                  └─► memory (FTS5 hive mind)
                       scheduler/heartbeat/cron drives proactive work
                       SQLite (better-sqlite3, WAL) underpins all of it
```

---

## 2. System catalogue

Each entry: **what it is**, **its file(s)**, and **what it connects to**.

### A. Surfaces (inbound message sources)

| System | File | What it does | Connects to |
| --- | --- | --- | --- |
| **Telegram adapter** | `src/adapters/telegram.ts` | grammY long-poll bot; allowlist; core slash commands; buffers streamed reply and sends on done. | → chat-dispatch; ← orchestrator stream; ← scheduler nudges; ← confirm-bus fallback |
| **Discord surface** (module) | `modules/modulus-discord` | Second chat surface over the Discord gateway WebSocket; DM-allowlist / per-channel opt-in; button confirm prompts. | → chat-dispatch (same pipeline as Telegram) |
| **Web panel** | `src/panel/server.ts` | In-process HTTP server serving the browser UI + token-gated JSON/SSE API. Handed the live engine. | → router → routes; → orchestrator (in-memory); → confirm-bus |
| **CLI** | `src/cli/index.ts` (+ `start.ts`, `daemon.ts`, `init.ts`, `status.ts`, `doctor.ts`, `module-admin.ts`, `auth.ts`, …) | commander entrypoint; boots the daemon, init/onboarding, status, module admin, model probes. Power-user surface. | → daemon boot; → installer; panel re-execs it via `spawn.ts` |

### B. Core engine

| System | File | What it does | Connects to |
| --- | --- | --- | --- |
| **chat-dispatch** | `src/core/chat-dispatch.ts` | Surface-neutral inbound pipeline shared by every surface: commands → intercepts → orchestrator turn → afterReply/afterTurn hooks. | ← all surfaces; → orchestrator; → instant-responses; → memory-extraction; → followups |
| **orchestrator** | `src/core/orchestrator.ts` | Two-queue conversation pipeline. Per-chat FIFO user queue (one reply in flight, `/stop` via AbortController) + after-turn hooks. Owns the turn. | → context; → tools; → llm-router; → memory; ↔ agent engine |
| **context manager** | `src/core/context.ts` | Builds the prompt in a fixed order — **system → tools → memory → session → history** — to keep Ollama's KV cache warm. Memory slot lives here. | ← memory; ← tools; → llm-router |
| **LLM router** | `src/core/llm-router.ts`, `llm.ts`, `model-family.ts`, `model-options.ts` | Profile routing (`chat`/`tools`/`reason`/literal model), heavy-model eviction (one resident), circuit breaker, think-suppression. Ollama HTTP; alias providers from modules. | ← orchestrator; → Ollama; ← modulus-openai / minimax / codex provider aliases |
| **tool engine** | `src/core/tools.ts`, `fs-tools.ts`, `tools.depth` | Registry of tool handlers, permission tiers (`auto`/`confirm`/`owner`), intent-pattern pruning, execution. | ← orchestrator; ← core tools + module tools; → confirm gate (Telegram / confirm-bus) |
| **memory (hive mind)** | `src/core/memory.ts` | One FTS5/BM25 SQLite table read+written by every agent and the main chat. `remember`/`forget` tools; per-agent namespaces (additive overlay). | ↔ context (memory slot); ← memory-extraction; ← dreaming; ← agent finding promotion |
| **memory-extraction** | `src/core/memory-extraction.ts` | After a chat turn, detached job pulls 0–2 durable user facts and `remember()`s them. Reply ships first. | ← chat-dispatch afterTurn; → memory; → llm-router (small model) |
| **dreaming** | `src/core/dreaming.ts` | Nightly scheduler job; deterministic (no model) memory consolidation — promote earning facts, decay stale extraction noise. | ← scheduler; → memory.consolidate |
| **instant-responses** | `src/core/instant-responses.ts` | Templated ack/reply shipped before the LLM runs; no model call. Gated by `instantResponses.enabled`. | ← chat-dispatch; ← panel SSE chat route |

### C. Agent fleet

| System | File | What it does | Connects to |
| --- | --- | --- | --- |
| **agent engine** | `src/core/agents.ts`, `agent-templates.ts`, `agent-knobs.ts` | An agent = named persona (system prompt, profile, tool allowlist, policy, delegation grant). Runs through the normal orchestrator against a virtual chat id. | → orchestrator; → agent-queue; ← module-declared agents |
| **agent queue (governor)** | `src/core/agent-queue.ts` | Resource-aware background queue keyed to the MODEL. ≤`heavyConcurrency` (default 1) heavy tasks; tiny-worker concurrency tiers. Owns model residency. | ← agent engine; → llm-router |
| **delegation** | `src/core/agent-delegation.ts`, `agent-delegation-args.ts` | `spawn_agent`/`spawn_agents` tools (supervisor→worker). Worker grant = supervisor ∩ worker allowlist; depth-capped. | ← agent engine; → tools; → agent-queue |
| **planning / autonomy** | `src/core/agent-planning.ts` | Plan→act→reflect autonomous loop with budgets, checkpoints, steer, escalation. | ← agent engine; → agent-queue |
| **agent routing & dispatch** | `src/core/agent-router.ts`, `chat-dispatch.ts` | Pick the best agent when the user didn't name one — deterministic rules first, tiny-model fallback. | ← chat-dispatch / panel dispatch-auto; → agent engine |
| **conversation routing** | `src/core/conversation-routing.ts` | Which persona is active for a chat. Unbound → default Modulus Agent; bound → that agent's prompt + tools + private memory namespace. | ← surfaces; → agent engine; → memory namespaces |
| **escalation / handoff / approvals / attachments / fleet tools** | `agent-escalation.ts`, `agent-handoff.ts`, `agent-approvals.ts`, `agent-attachments.ts`, `agent-fleet-tools.ts`, `agent-schedules.ts` | Tier escalation, handoff between agents, approval gating, file attachments on tasks, fleet-management tools, per-agent schedules. | ↔ agent engine; → tools; → scheduler |

### D. Modules & marketplace

| System | File | What it does | Connects to |
| --- | --- | --- | --- |
| **module loader** | `src/core/modules.ts` | Discover → validate manifest → migrate → register tools/commands/agents/jobs/auth; capability gating; hot-reload. Turns the bot into "does anything". | → tools; → agent engine; → scheduler; → DB migrations; ← module-watcher |
| **module watcher / readiness / npm-deps / tripwires** | `module-watcher.ts`, `module-readiness.ts`, `module-npm-deps.ts`, `module-tripwires.ts` | Watch module folders for hot-reload; readiness sweep; per-module npm dep install on enable; runtime allowlist tripwires (fetch/spawn/fs) with denied counters. | ← loader; → panel System tab; → installer |
| **registry client** | `src/core/registry.ts` | Fetch + parse the marketplace `index.json` (pinned tarball + sha256). FETCH/PARSE only. | → installer |
| **installer** | `src/core/installer.ts` | index → download tarball → sha256 verify → strict (zip-slip-safe) extract → manifest validate → [caller consent] → commit. Shared by CLI + panel. | ← registry; ← panel modules route / CLI; → loader |
| **skills loader** | `src/core/skills.ts`, `skill-tools.ts`, `skill-improve.ts` | Code-free sibling of the loader: discovers `skill.json` + `SKILL.md` pure-prompt bundles, `assertNoExecutableContent` gate, no dynamic import. Safe tier of the marketplace. | → tools (allowlist intersection); ← installer |

### E. Scheduling & proactivity

| System | File | What it does | Connects to |
| --- | --- | --- | --- |
| **scheduler** | `src/core/scheduler.ts` | Cron tick + registry of module/core jobs + fast-cache + nudge dispatcher that pushes job output into chats. | ← cron; ← jobs; → surfaces (nudges) |
| **cron parser** | `src/core/cron.ts` | Minimal 5-field cron (Vixie day semantics). | ← scheduler; ← heartbeat |
| **heartbeat** | `src/core/heartbeat.ts` | One cheap registered job giving Modulus a pulse; evaluates standing orders each beat, escalates only when due. | ← scheduler; → standing-orders; → agent queue |
| **standing orders** | `src/core/standing-orders.ts` | Conditional agency evaluated each beat — enqueue an agent to check/report, or nudge on observed state change. | ← heartbeat; → agent engine; → scheduler |
| **followups** | `src/core/followups.ts` | `schedule_followup` tool: model commits to messaging the user later; per-minute sweep emits nudges. | ← tools; → scheduler |

### F. Panel internals

| System | File | What it does | Connects to |
| --- | --- | --- | --- |
| **panel router** | `src/panel/router.ts` | Tiny method+path router; tries each RouteModule in order, 404s if none claim it. | ← server; → routes |
| **panel auth** | `src/panel/auth.ts`, `auth-backoff.ts` | Single bearer token gates `/api/*`; loopback bind by default; constant-time compare; backoff on failures. | ← server; gates all routes |
| **routes** | `src/panel/routes/{chat,agents,modules,settings,system,skills,setup,confirm-registry}.ts` | chat (send/stream/attachments), agents (fleet CRUD + live SSE run view), modules (marketplace), settings (toggles + memory browser), system (CPU/RAM/logs/metrics), skills, setup wizard, confirm registry. | → orchestrator, agent engine, installer, memory, metrics |
| **confirm-bus** | `src/panel/confirm-bus.ts` | Bridges confirm-tier tool gate to the browser; live panel turn renders inline, else falls through to chat surfaces. | ← tool engine; ↔ Telegram fallback |
| **state / metrics** | `src/panel/state.ts`, `src/core/metrics.ts` | Aggregated dashboard state (config, Ollama probe, module readiness, metrics snapshot); metrics counters. | → System/Dashboard tabs |
| **telegram-pairing** | `src/panel/telegram-pairing.ts` | Pairs a Telegram chat to the panel from onboarding. | ↔ Telegram adapter |
| **web UI** | `src/panel/web/*.jsx` | React (no build step, in-browser Babel): `app`, `chathub`, `agentchat`, `agents`, `modules`, `settings`, `system`, `voicehub`, `docs`, `wizard`. | ← routes (fetch/SSE) |

### G. Storage

| System | File | What it does | Connects to |
| --- | --- | --- | --- |
| **DB + migrations** | `src/storage/db.ts`, `src/storage/migrations/0001…0035*.sql` | better-sqlite3, WAL, numbered append-only migrations with checksum tracking; refuses to start on drift. | ← everything that persists (memory, agents, schedules, modules, skills, conversations) |

### H. Modules (first-party)

| Module | What it does | Adds | Connects to |
| --- | --- | --- | --- |
| **modulus-assistant** | Everyday assistant: calendar, tasks, reminders, weather, briefings, day-planning. | tools, commands, jobs, OAuth | Google APIs, open-meteo; scheduler; Telegram cmds |
| **modulus-browser** | Drives a real headless browser (navigate/read/click/type/screenshot) with SSRF guards. Heavy (Playwright+Chromium). | tools, `browser-operator` agent | agent fleet; tool engine |
| **modulus-codex** | Escalate hard tasks to OpenAI Codex over a ChatGPT subscription (OAuth). Deep-reasoning brain. | tools, commands, OAuth, `coder` agent | api.openai.com; LLM router; agent fleet |
| **modulus-discord** | Discord as a second chat surface (gateway WebSocket, allowlist, button confirms). | jobs, commands, auth, setup | chat-dispatch; Discord API |
| **modulus-mcp** | Connect MCP servers (stdio/HTTP); their tools appear as `mcp__<server>__<tool>`, confirm-tier until promoted. | tools | tool engine; arbitrary MCP servers |
| **modulus-minimax** | Adds MiniMax (chatcompletion_v2) as an LLM provider (not OpenAI-compatible). | tools, commands, auth | LLM router (provider alias); api.minimaxi.chat |
| **modulus-openai** | Register OpenAI-compatible chat-completions endpoints as provider aliases. **Power Mode** backbone. | tools, commands | LLM router (provider alias); api.openai.com / deepseek |
| **modulus-voice** | Two-way Telegram voice: Piper TTS out, whisper.cpp transcription in. | commands, jobs, auth, setup | Telegram adapter; github/huggingface (model fetch) |
| **modulus-websearch** | Web search as a safe read-only tool (DuckDuckGo / self-hosted SearXNG), SSRF-guarded, framed as untrusted data. | tools, command | tool engine; html.duckduckgo.com |
| **modulus-abilitytest** | Scripted FakeLLM ability tests booting throwaway orchestrators to score tool-selection/delegation/outcomes. | CLI eval harness | orchestrator (test harness) |

---

## 3. Key cross-cutting invariants (edges that must never break)

- **Deterministic prompt prefix**: system → tools → memory → session → history (context manager).
- **One heavy model resident**: the agent-queue governor owns residency; LLM router evicts.
- **Reply-first**: user-facing reply ships before memory extraction / promotions (background queue).
- **Delegation grant intersection**: worker grant = supervisor ∩ worker allowlist, depth-capped; confirm/owner fail closed unattended.
- **Safe by default**: loopback token-auth panel; curated sha256-pinned registry; consent screens; module tripwires.

---

## 4. Prompt for Claude Opus 4.8 — interactive tree-graph artifact

Paste everything in the fenced block below into a new Claude chat (Opus 4.8). It
embeds the catalogue, so the artifact is self-contained.

````text
You are building a single self-contained HTML artifact: an interactive tree graph
of the Modulus system architecture. Modulus is one Node daemon (a local AI
orchestrator) — Telegram bot + agent engine + web panel + scheduler in one
process, with Ollama as the only separate process, plus drop-in modules.

REQUIREMENTS
1. Output ONE HTML file as an artifact. No external network calls, no CDNs — all
   CSS and JS inline. It must run offline by opening the file.
2. Render a TREE GRAPH (hierarchical node-link diagram). Root = "Modulus Daemon".
   Children are the layers; each layer's children are its systems; modules hang
   under a "Modules" branch. Use SVG (or canvas) drawn by hand-written JS — do
   NOT depend on D3 or any library unless you inline it fully.
3. CLICKING a node opens a side panel (or modal) showing that node's name, its
   one-line "what it does", its file path(s), and "connects to" list. Clicking
   the background closes it. Selected node is visually highlighted.
4. Draw the cross-layer "connects to" relationships as faint dashed edges in
   addition to the solid tree edges, so the one-process wiring is visible. A
   toggle button shows/hides these dashed edges.
5. Collapsible branches: clicking a node's expand/collapse handle (or
   double-click) folds its subtree. Start with all layers expanded, modules
   collapsed.
6. Theme: near-black background, light text, a purple→pink accent gradient
   (linear-gradient(135deg, #8b5cf6, #ec4899)) for the root, selected node, and
   the panel header — this matches Modulus's brand (a purple/pink DNA helix).
   Each layer gets its own accent tint for its nodes. Rounded node cards,
   subtle drop shadows, smooth CSS transitions on hover/select.
7. Layout must be readable: auto-size the SVG, allow pan (drag) and zoom
   (wheel / +,- buttons / fit button). Wrap long labels. Don't let nodes
   overlap. Make it work on a laptop screen and degrade gracefully on mobile.
8. A small legend maps layer colors to layer names. A title header reads
   "Modulus — System Architecture".

DATA (use exactly this; id is the key, "to" lists target ids for dashed edges):
Layers: Surfaces, Core Engine, Agent Fleet, Modules & Marketplace,
Scheduling & Proactivity, Panel, Storage, Modules.

Nodes:
- root: Modulus Daemon — "One Node process: chat surfaces + agent engine + web panel + scheduler. Ollama is the only separate process." files: src/cli/start.ts
SURFACES:
- telegram: Telegram Adapter — "grammY long-poll bot; allowlist; core slash commands; buffers and sends the streamed reply." files: src/adapters/telegram.ts. to: chat-dispatch
- discord: Discord Surface (module) — "Second chat surface over the Discord gateway WebSocket; allowlist; button confirms." files: modules/modulus-discord. to: chat-dispatch
- panel: Web Panel — "In-process HTTP server: browser UI + token-gated JSON/SSE API, handed the live engine." files: src/panel/server.ts. to: router, orchestrator, confirm-bus
- cli: CLI — "commander entrypoint: boots the daemon, init/onboarding, status, module admin, model probes." files: src/cli/index.ts. to: installer, daemon
CORE ENGINE:
- chat-dispatch: chat-dispatch — "Surface-neutral inbound pipeline: commands -> intercepts -> orchestrator turn -> afterReply/afterTurn hooks." files: src/core/chat-dispatch.ts. to: orchestrator, instant-responses, memory-extraction, followups, agent-router
- orchestrator: Orchestrator — "Two-queue conversation pipeline: per-chat FIFO user queue + after-turn hooks. Owns the turn; /stop via AbortController." files: src/core/orchestrator.ts. to: context, tools, llm-router, memory, agents
- context: Context Manager — "Builds the prompt in a fixed order system -> tools -> memory -> session -> history to keep Ollama's KV cache warm." files: src/core/context.ts. to: memory, llm-router
- llm-router: LLM Router — "Profile routing (chat/tools/reason); heavy-model eviction (one resident); circuit breaker; think-suppression. Ollama HTTP." files: src/core/llm-router.ts, src/core/llm.ts. to: ollama
- tools: Tool Engine — "Registry of tool handlers; permission tiers auto/confirm/owner; intent-pattern pruning; execution." files: src/core/tools.ts. to: confirm-bus
- memory: Memory (Hive Mind) — "One FTS5/BM25 SQLite table every agent and the main chat read+write; per-agent namespaces." files: src/core/memory.ts. to: context, db
- memory-extraction: Memory Extraction — "After a turn, a detached job pulls 0-2 durable user facts and remember()s them. Reply ships first." files: src/core/memory-extraction.ts. to: memory, llm-router
- dreaming: Dreaming Pass — "Nightly deterministic (no model) memory consolidation: promote earning facts, decay stale noise." files: src/core/dreaming.ts. to: memory, scheduler
- instant-responses: Instant Responses — "Templated ack shipped before the LLM runs; no model call. Gated by a setting." files: src/core/instant-responses.ts. to: chat-dispatch
AGENT FLEET:
- agents: Agent Engine — "An agent = named persona (prompt, profile, tool allowlist, policy, delegation grant) run through the orchestrator." files: src/core/agents.ts. to: orchestrator, agent-queue
- agent-queue: Agent Queue (Governor) — "Resource-aware background queue keyed to the MODEL; <=1 heavy task; tiny-worker tiers. Owns residency." files: src/core/agent-queue.ts. to: llm-router
- delegation: Delegation — "spawn_agent/spawn_agents tools; worker grant = supervisor INTERSECT worker allowlist; depth-capped." files: src/core/agent-delegation.ts. to: tools, agent-queue
- planning: Planning / Autonomy — "Plan->act->reflect autonomous loop with budgets, checkpoints, steer, escalation." files: src/core/agent-planning.ts. to: agent-queue
- agent-router: Agent Router — "Pick the best agent when none named: deterministic rules first, tiny-model fallback." files: src/core/agent-router.ts. to: agents
- conversation-routing: Conversation Routing — "Which persona is active for a chat: unbound -> Modulus Agent; bound -> that agent's prompt+tools+namespace." files: src/core/conversation-routing.ts. to: agents, memory
MODULES & MARKETPLACE:
- modules: Module Loader — "Discover -> validate -> migrate -> register tools/commands/agents/jobs; capability gating; hot-reload." files: src/core/modules.ts. to: tools, agents, scheduler, db
- registry: Registry Client — "Fetch + parse the marketplace index.json (pinned tarball + sha256). Fetch/parse only." files: src/core/registry.ts. to: installer
- installer: Installer — "index -> download -> sha256 verify -> strict extract -> manifest validate -> consent -> commit. Shared by CLI + panel." files: src/core/installer.ts. to: modules
- skills: Skills Loader — "Code-free sibling of the loader: skill.json + SKILL.md pure-prompt bundles; no dynamic import. Safe tier." files: src/core/skills.ts. to: tools
SCHEDULING & PROACTIVITY:
- scheduler: Scheduler — "Cron tick + registry of jobs + fast-cache + nudge dispatcher pushing job output into chats." files: src/core/scheduler.ts. to: telegram
- heartbeat: Heartbeat — "One cheap registered job: evaluates standing orders each beat, escalates only when due." files: src/core/heartbeat.ts. to: standing-orders, agent-queue
- standing-orders: Standing Orders — "Conditional agency evaluated each beat: enqueue an agent to check/report or nudge on state change." files: src/core/standing-orders.ts. to: agents, scheduler
- followups: Followups — "schedule_followup tool: model commits to messaging later; per-minute sweep emits nudges." files: src/core/followups.ts. to: scheduler
PANEL:
- router: Panel Router — "Tiny method+path router; tries each RouteModule in order, 404s if none claim it." files: src/panel/router.ts. to: routes
- auth: Panel Auth — "Single bearer token gates /api/*; loopback bind by default; constant-time compare." files: src/panel/auth.ts. to: router
- routes: Panel Routes — "chat, agents (live SSE run view), modules, settings (memory browser), system, skills, setup." files: src/panel/routes/*. to: orchestrator, agents, installer, memory
- confirm-bus: Confirm Bus — "Bridges confirm-tier tool gate to the browser; live panel turn renders inline, else falls to chat surfaces." files: src/panel/confirm-bus.ts. to: tools
- web: Web UI — "React with no build step (in-browser Babel): chathub, agents, modules, settings, system, wizard." files: src/panel/web/*.jsx. to: routes
STORAGE:
- db: DB + Migrations — "better-sqlite3, WAL, numbered append-only migrations with checksum tracking; refuses to start on drift." files: src/storage/db.ts, src/storage/migrations/*
EXTERNAL:
- ollama: Ollama — "The only separate process. Local LLM inference over HTTP; never bundled." files: external
MODULES (collapsed branch under "Modules"):
- m-assistant: modulus-assistant — "Everyday assistant: calendar, tasks, reminders, weather, briefings, day-planning." adds: tools, commands, jobs, OAuth. to: scheduler, telegram
- m-browser: modulus-browser — "Drives a real headless browser with SSRF guards. Heavy (Playwright+Chromium). Ships a browser-operator agent." adds: tools, agent. to: agents, tools
- m-codex: modulus-codex — "Escalate hard tasks to OpenAI Codex over a ChatGPT subscription (OAuth). Ships a coder agent." adds: tools, commands, OAuth, agent. to: llm-router, agents
- m-discord: modulus-discord — "Discord as a second chat surface (gateway WebSocket, allowlist, button confirms)." adds: jobs, commands, auth. to: chat-dispatch
- m-mcp: modulus-mcp — "Connect MCP servers (stdio/HTTP); their tools appear as mcp__server__tool, confirm-tier until promoted." adds: tools. to: tools
- m-minimax: modulus-minimax — "Adds MiniMax (chatcompletion_v2) as an LLM provider (not OpenAI-compatible)." adds: tools, commands, auth. to: llm-router
- m-openai: modulus-openai — "Register OpenAI-compatible endpoints as provider aliases. The Power Mode backbone." adds: tools, commands. to: llm-router
- m-voice: modulus-voice — "Two-way Telegram voice: Piper TTS out, whisper.cpp transcription in." adds: commands, jobs, auth. to: telegram
- m-websearch: modulus-websearch — "Web search as a safe read-only tool (DuckDuckGo/SearXNG), SSRF-guarded, framed as untrusted data." adds: tools, command. to: tools
- m-abilitytest: modulus-abilitytest — "Scripted FakeLLM ability tests booting throwaway orchestrators to score tool-selection/delegation/outcomes." adds: CLI eval harness. to: orchestrator

TREE STRUCTURE (parent -> children):
- root -> Surfaces, Core Engine, Agent Fleet, Modules & Marketplace, Scheduling & Proactivity, Panel, Storage, Modules, ollama
- Surfaces -> telegram, discord, panel, cli
- Core Engine -> chat-dispatch, orchestrator, context, llm-router, tools, memory, memory-extraction, dreaming, instant-responses
- Agent Fleet -> agents, agent-queue, delegation, planning, agent-router, conversation-routing
- Modules & Marketplace -> modules, registry, installer, skills
- Scheduling & Proactivity -> scheduler, heartbeat, standing-orders, followups
- Panel -> router, auth, routes, confirm-bus, web
- Storage -> db
- Modules -> m-assistant, m-browser, m-codex, m-discord, m-mcp, m-minimax, m-openai, m-voice, m-websearch, m-abilitytest

DELIVERABLE
Build the artifact now. Make sure clicking any node reveals its description,
files, and connections; the dashed cross-edge toggle works; pan/zoom/fit work;
and the whole thing is one offline HTML file. Verify there are no console errors
and that node labels never overflow their cards.
````

---

*Generated from a read of `src/` and `modules/` on the `claude/system-architecture-graph-rxopbf` branch.*
