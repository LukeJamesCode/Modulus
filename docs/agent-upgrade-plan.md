# Agent System Upgrade Plan

Status: **proposal** — written June 2026 against the v1.0.0 codebase (784/785 tests green).

This plan covers three things:

1. **Bug fixes** — verified defects in the current agent system, with file/line citations.
2. **Simplification** — making agents dramatically easier to use well, without new infrastructure.
3. **Competitive features** — closing the gap with OpenClaw and Nous Research's Hermes agent, while
   doubling down on the two things neither of them has: a Pi-class CPU-only footprint and a
   curated, sha256-pinned module registry (vs. ClawHub's 800+ confirmed-malicious skills).

---

## Where Modulus stands today

The agent engine is in good shape: resource-aware task queue keyed to model heaviness
(`src/core/agent-queue.ts`), a checkpointed plan→act→reflect autonomous loop with round and
wall-clock budgets (`src/core/agents.ts`), delegation with depth-capped, intersected tool grants
(`src/core/agent-delegation.ts`), recurring agent schedules (`src/core/agent-schedules.ts`),
workflows, per-agent panel DMs, shared FTS5 hive memory, and a deterministic eval harness
(`modulus-abilitytest`). All of it is tested.

What it lacks is mostly **surface polish** (the panel exposes raw knobs, not concepts) and a
handful of **automation/memory primitives** that OpenClaw and Hermes have made table stakes.

---

## Phase 0 — Bug fixes (small, do first)

These were found by audit and verified against source. Each is an afternoon-sized fix with a test.

### 0.1 Resuming a single task doesn't wake the queue
`POST /api/agents/tasks/:id/resume` flips the row to `queued` but never calls
`deps.agentQueue.notify()` (`src/panel/routes/agents.ts:640`), while the bulk
`resume_all` path does (`src/panel/routes/agents.ts:552`). A resumed task sits idle until some
other task finishes and triggers a scan. Fix: add the `notify()` call (also audit the global
`resume_all` route and `pause` paths for the same omission).

### 0.2 Module-origin agents can be edited and deleted, then silently revert
The registry's `update()` and `remove()` never check `origin`
(`src/core/agents.ts:559`, `src/core/agents.ts:627`), and the panel `PUT`/`DELETE` routes pass
straight through (`src/panel/routes/agents.ts:392-401`). A user can edit or delete a
`module:<name>` agent, and the module loader resurrects/reverts it on the next reload with no
explanation. Fix: reject mutation of module-origin agents at the registry layer with a clear
error (`"this agent is managed by <module>; disable the module to remove it"`), and have the
panel render module agents as read-only. Allow a narrow exception: a per-agent *user overlay*
(e.g. extra standing orders, see 2.2) that survives reloads instead of fighting the loader.

### 0.3 Stall guard cuts off legitimate long steps
`AUTONOMOUS_STALL_LIMIT = 5` is a hardcoded constant (`src/core/agents.ts:110`), and the loop
finalizes after 5 turns without a `complete_step` (`src/core/agents.ts:1569`). The code comment
acknowledges a single legitimately long step trips it. Fix in two parts:
- Make the stall limit a per-agent field (default 5) alongside `maxTotalRounds`.
- Before finalizing, give the model one warning turn ("you appear stalled — complete a step or
  call finish") instead of cutting straight to the finalize prompt. Cheap, and recovers the
  common case where a small model just forgot to call `complete_step`.

### 0.4 Grant intersection silently produces an empty toolset
`intersectGrants()` is a pure string-set intersection (`src/core/agents.ts:134-139`). If a
supervisor's grant says `['modulus-websearch']` (module name) and the worker's says
`['websearch_search']` (tool name), the child gets **zero tools** with no warning — documented
as "only ever over-restricts", but in practice it makes delegation chains fail mysteriously.
Fix: resolve module names to their tool sets before intersecting (the registry already knows the
mapping), and log a warning when an intersection comes out empty.

### 0.5 Verified non-bugs (for the record)
- The DM-confirm timeout **is** enforced (`src/panel/routes/agents.ts:193`) — an earlier audit
  pass flagged it incorrectly.
- Attachment staging path traversal is blocked: `normalize()` plus the `..`-component check
  (`src/panel/routes/agents.ts:425-426`) holds on both separators. Keep the existing test
  coverage; no change needed.

---

## Phase 1 — Simplification: make the existing engine easy to use well

No new engine features — just removing the need to understand internals. This is where Modulus
loses to both competitors today: OpenClaw has an onboarding wizard and Hermes has
`hermes setup`; both make the *first agent* effortless.

### 1.1 Agent templates ("hire an agent", not "configure 12 fields")
Creating an agent today means writing a system prompt from scratch and hand-typing a tool
allowlist. Ship a small library of starter templates (Researcher, Daily Briefer, Watchdog,
Coder/Escalator, Inbox Triager) selectable in the panel's create flow: each pre-fills prompt,
mode, profile, tools, and budgets, then lets the user tweak. Templates are data, not code — a
JSON list in core, and modules can contribute templates via the manifest the same way they
contribute agents.

### 1.2 Plain-language knobs
- Replace the `single`/`autonomous` mode dropdown with a described choice: *"Quick task — one
  pass and reply"* vs *"Project — plans steps and works until done (up to N rounds / M
  minutes)"*, with budgets shown inline rather than buried.
- Replace the comma-separated `toolAllowlist` text box with a grouped checkbox picker (group by
  module, "everything" as the null state), showing the **resolved** tool list. This also
  surfaces the 0.4 fix: when editing a delegating agent, preview what each delegatable worker
  would actually receive after intersection.

### 1.3 One-request dispatch with attachments
Dispatch currently requires staging files under a token, then a second call. Accept
`multipart/form-data` directly on `POST /api/agents/:id/dispatch` and keep the staging flow as
the internal mechanism. One less concept for API users and the panel alike.

### 1.4 Agents from chat, not just the panel
Telegram (and the Dashboard chat) can run agents but not manage them. Add `/agent new` (walks
template selection via buttons), `/agent list`, `/agent run <name> <task>` — the confirm-button
plumbing for Telegram already exists. This matches how OpenClaw/Hermes users actually live: in
the chat app, not the admin panel.

### 1.5 Task notifications
There is no "tell me when it's done" today — the user has to watch the panel. On `onTaskDone`,
deliver a short result message to the surface that dispatched the task (Telegram chat, panel DM),
including failures. This is the single highest-leverage UX gap for autonomous runs, and the
plumbing (proactive Telegram sends, the nudge system) already exists.

---

## Phase 2 — Competitive parity features

Mapped from OpenClaw (heartbeat / cron / standing orders / markdown memory / skills) and Hermes
(self-writing skills, reasoning toggles, NL scheduling, security-by-default). Ordered by
value-for-effort on Pi-class hardware.

### 2.1 Heartbeat (OpenClaw's most-loved primitive)
A periodic agent turn (default 30 min, quiet-hours aware) that runs a user-editable checklist —
"check the calendar for conflicts, scan reminders, surface anything urgent" — and **stays
silent unless something needs attention**. Modulus already has the scheduler, proactive sends,
and quiet hours; this is a thin layer: a per-agent `heartbeat` config (interval + checklist
prompt) and a suppression rule (no output → no message). Differentiator: tier-aware defaults so
a Pi runs the heartbeat on the tiny model.

### 2.2 Standing orders
Per-agent durable instructions injected every run, editable as plain text in the panel and via
chat ("from now on, always reply in bullet points"). This is OpenClaw's `AGENTS.md` concept, and
it's also the clean answer to 0.2: standing orders are the *user-owned overlay* on module-owned
agents. Storage: a new `agent_standing_orders` column or table; injection point already exists
(system prompt assembly).

### 2.3 Finish the memory story (already half-built)
- **Implement the memory extraction job** — it is fully specced in `docs/memory-extraction.md`
  ("Status: spec only") and the `remember(source: 'extraction')` interface already exists
  (`src/core/memory.ts:13`). This is the known unfinished Phase-3 item.
- **Promotion pass ("dreaming")**: a low-priority scheduled job that re-scores recent memories
  by recall frequency and promotes/demotes importance — OpenClaw's "dreaming" in one cron job,
  using the existing importance-aware eviction.
- **Per-agent memory namespace**: today all agents share one hive. Add an optional
  `agent:<id>` scope tag on `remember`/`recall` so an agent can keep private working knowledge
  while still reading the hive. Embeddings stay V2 (FTS5/BM25 is the right call for CPU-only);
  revisit only if recall quality measurably blocks users.

### 2.4 Skills: composite tools with a curated registry
Both competitors center on a skills ecosystem; both got burned (ClawHub: 820+ malicious skills;
Hermes inherited the same attack surface). Modulus's wedge is **skills with the marketplace's
trust model**: a skill is a declarative file (markdown instructions + allowed tools + optional
few-shot examples) that an agent can load, distributed through the existing sha256-pinned,
consent-screened registry. Implementation: a `skills` array in the module manifest plus a
`load_skill` tool; no arbitrary code, so a skill can never exceed the module permissions the
user already consented to. Evaluate **agentskills.io compatibility** (the open standard Hermes
adopted) as an import format — instant ecosystem reach, gated through the same consent screen.

### 2.5 Natural-language scheduling
Hermes ships NL-configured cron. Modulus already parses recurrence (`advanceNextRun` handles
month-boundary cases); add a small parse step ("every weekday at 8am", "Sunday evenings") in the
schedule create flow and a `schedule_task` tool so users can just *tell* the agent, in chat, to
do something later. The deterministic parser runs first; only fall back to the LLM for phrases
it can't handle.

### 2.6 Reasoning controls in chat
Hermes's `/reasoning high|none|show|hide` is loved because effort becomes a per-message choice.
Modulus already has thinking modes and a reasoning-model profile — expose them: `/think` and
`/fast` prefixes in Telegram and the panel chat, plus a per-agent default. Mostly a dispatch-layer
change (`src/core/chat-dispatch.ts`).

### 2.7 Security-by-default hardening (the marketing-grade differentiator)
Hermes ships prompt-injection scanning and credential filtering by default; OpenClaw's
reputation was damaged by ClawJacked (CVE-2026-25253) and ToxicSkills. Modulus already frames
websearch results as untrusted — generalize it:
- Wrap **all** tool output from network-facing modules in the untrusted-data envelope, not just
  websearch.
- Add a cheap injection heuristic pass (regex/keyword tier, no model call) over untrusted tool
  output that flags "ignore your instructions"-class content before it reaches the prompt.
- Redact known secret patterns (the redaction code already exists for logs) from any text an
  agent sends outbound.
- Document it: a "why Modulus is safe to run at home" page. Given the competitors' 2026
  security press, this is a top-three reason to choose Modulus.

---

## Phase 3 — Bigger bets (sequence after Phases 0–2 land)

- **Cross-surface bindings**: OpenClaw-style routing — map a channel/account/group to a
  specific agent (e.g. Discord #research → Researcher agent, Telegram DM → Modulus). The
  dispatch layer is already surface-aware; this is a routing table plus panel UI.
- **Agent-to-agent handoff**: a `notify_agent` tool so a heartbeat agent can hand work to a
  specialist without the user relaying it. Keep the depth cap; this is messaging, not recursion.
- **Self-improving skills (Hermes's learning loop)**: after a successful autonomous run, an
  extraction pass writes a draft skill file from the plan + findings, parked for user approval
  (never auto-activated — that's how ToxicSkills happens at home). Builds directly on 2.3's
  extraction job and 2.4's skill format.
- **MCP client support**: a `modulus-mcp` *module* (not core) that bridges MCP servers into the
  tool registry, with each server's tools gated behind the standard consent screen. Hermes has
  it; for Modulus it's also the cheapest path to hundreds of integrations.
- **One-command install**: `npx modulus` is already on the README roadmap; both competitors
  ship one-liner installs and it is the first thing a switcher sees.
- **`/undo`** (retract last N turns from a conversation) — small, popular Hermes feature; the
  conversation store makes it straightforward.

Explicit non-goals for this cycle: 20+ chat channels (Telegram + Discord + panel is the right
scope for a Pi appliance; Matrix is the only candidate worth considering), voice canvas / A2UI,
embedding-based memory (V2 as documented), and module sandboxing beyond the existing tripwires
(V2 as documented — but keep it on the security roadmap since it's now a competitive talking
point, not just hygiene).

---

## Suggested sequencing

| Milestone | Contents | Size |
|---|---|---|
| **1.1.0** | Phase 0 bug fixes + task notifications (1.5) + reasoning controls (2.6) | days |
| **1.2.0** | Templates, plain-language knobs, one-request dispatch, chat-based agent mgmt (1.1–1.4) | ~1–2 weeks |
| **1.3.0** | Heartbeat + standing orders + NL scheduling (2.1, 2.2, 2.5) | ~1–2 weeks |
| **1.4.0** | Memory completion: extraction job, dreaming, agent namespaces (2.3) | ~1–2 weeks |
| **1.5.0** | Skills + curated skill registry + security hardening (2.4, 2.7) | ~2–3 weeks |
| **2.0.0** | Phase 3 bets, prioritized by 1.x feedback | — |

Every milestone should land with abilitytest catalog additions (e.g. heartbeat suppression,
skill selection, NL-schedule parsing are all FakeLLM-testable) so the eval harness keeps pace
with the features — that harness is itself a differentiator neither competitor ships.
