# 2.0.0 Plan 1 — Conversation routing: channel→agent bindings + agent-to-agent handoff

**Bundled because** both features add and consume one new layer — _which agent is
the active persona for a conversation_ (`chatId → agentId`) — and both edit
`chat-dispatch.ts`, `agents.ts`, the Telegram surface, and the panel Agents tab.
A **binding** is the user statically setting that mapping; a **handoff** is an
agent dynamically rewriting it mid-conversation. Same state, same seams.

## Today (the seam)

- Every surface (Telegram chat, Discord channel, panel Dashboard) reduces an
  inbound message to a numeric `chatId`, then `chat-dispatch.ts` →
  `orchestrator.handleUserMessage`.
- There is exactly **one** chat orchestrator (`createOrchestrator` in
  `src/cli/start.ts:447`), seeded with the default Modulus persona
  (`DEFAULT_SYSTEM`) and `chatTools`.
- Background agent _tasks_ already run as personas through per-agent orchestrators
  built inside `agents.ts` (keyed off `AGENT_CHAT_ID_BASE + taskId`). What's
  missing is running an **interactive chat turn** as a chosen agent, and letting
  an agent pass the conversation to a peer.

## Design — the `ConversationRouter`

New core file **`src/core/conversation-routing.ts`** owns the mapping and the
per-agent chat-orchestrator cache.

```ts
export interface ConversationRouter {
  bind(chatId: number, agentId: number, setBy: string): void; // upsert
  unbind(chatId: number): void;
  boundAgentId(chatId: number): number | null;
  list(): ConversationBinding[];
  // The orchestrator to run THIS chat's turn against: the bound agent's chat
  // orchestrator, or the default Modulus orchestrator when unbound.
  orchestratorFor(chatId: number): HostOrchestrator;
  onAgentRemoved(agentId: number): void; // drop bindings + cached orchestrator
  onAgentUpdated(agentId: number): void; // invalidate cached orchestrator
}
```

- Backed by table `conversation_bindings` + an in-memory cache, loaded once at
  boot and kept warm.
- `orchestratorFor` **memoizes one chat orchestrator per bound agentId** (not per
  chat) via a factory injected from `start.ts`. One orchestrator per agent keeps
  the deterministic-prefix / KV-cache invariant intact: each agent has its own
  stable `system → tools → session → history` prefix (volatile clock + recalled
  memory ride the tail, before the latest user turn — see `src/core/context.ts`);
  binding swaps _which_ stable prefix is used, never reorders one. The default (unbound)
  orchestrator is the existing main orchestrator, untouched.

### Per-agent chat orchestrator (the factory)

Add an exported helper in **`src/core/agents.ts`** (next to the existing task
`buildOrchestrator`) — `buildChatOrchestratorForAgent(agent, deps)` — or, to keep
`start.ts` the only wiring point, build the factory inline there. Either way the
per-agent chat orchestrator is `createOrchestrator({...})` with:

- `systemPrompt = agent.systemPrompt`
- `tools = filterToolRegistry(chatTools, h => agentAllows(agent, h.name))` — the
  agent's `toolAllowlist` intersected with `chatTools` (still **no** agent-only
  control-plane tools: `spawn_agent`, `spawn_agents`, `request_approval`,
  `escalate_to_agent` stay hidden; the new `handoff` tool is the bound agent's one
  control-plane verb, see below).
- `profile = agent.profile`
- `memoryProvider` scoped to that agent's namespace (reuse the 0032 overlay:
  `recallScoped(message, agent.id)`), so a bound agent has its private working
  memory plus the shared hive — exactly like a task run.
- Same `promptFragmentProvider`, `toolIntentFilter`, `turnGuards`, budgets, and
  `skills` activation as the main orchestrator.

Result: chatting with a bound agent is the same interactive pipeline (instant
responses, confirm-tier prompts on the originating surface, memory extraction)
but with that agent's voice, tools, and memory.

### Routing in chat-dispatch

`chat-dispatch.ts` stays surface-neutral. Add **one** optional dep:

```ts
// In ChatDispatcherDeps:
resolveOrchestrator?: (chatId: number) => HostOrchestrator;  // default: deps.orchestrator
```

`dispatchOrchestratorTurn` calls `deps.resolveOrchestrator?.(chatId) ??
deps.orchestrator`. Telegram and the module loader's plain dispatcher both pass
`router.orchestratorFor`. No grammY, no agents import leaks into chat-dispatch —
just a resolver hook, mirroring how `getThinkMode`/`getDevmode` are injected.

## Design — handoff (the dynamic writer)

### Chat-surface handoff (primary)

New core file **`src/core/agent-handoff.ts`** (sibling of `agent-delegation.ts` /
`agent-escalation.ts`), registering the `handoff` tool:

- `tier: 'auto'`, `selfReplying: true` (like `escalate_to_agent`).
- Visible to the **main chat** and to **bound agents** (it's a chat-surface verb);
  hidden from background agent _task_ runs (those delegate with `spawn_agent`).
- `invoke(args, ctx)`:
  - Resolve `ctx.chatId`. If it's an `AGENT_CHAT_ID_BASE` task chat, refuse
    ("agents delegate with spawn_agent; handoff is for a live conversation") —
    mirror `escalate_to_agent`'s inverse guard.
  - Resolve target by name; refuse unknown.
  - **Grant model:** if the _calling_ persona is a bound agent with a non-empty
    `delegatableAgents`, the target must be in it (reuse the delegation allowlist
    semantics; `[]` = any). The default Modulus agent may hand off to any agent.
    Handoff does **not** widen tools — the target runs with its own consented
    allowlist (the user could `/bind` to it directly anyway, so this grants
    nothing new).
  - **Ping-pong guard:** cap handoffs per chat within a short rolling window
    (e.g. ≤ 3 in 60 s) to stop two agents bouncing a user back and forth; over the
    cap, refuse and stay put.
  - Effect: `router.bind(chatId, target.id, 'handoff:<callerName>')`, then return
    a `selfReplying` message: _"Handing you over to **<target>** — <note>."_ The
    next turn on this chat runs as the target. Optionally seed the target's first
    turn with the handoff note via the shared memory/session (v1: include the note
    in the reply text only; deeper context-passing is a follow-up).

### Background-task handoff (secondary, smaller)

`handoff_task` tool (also in `agent-handoff.ts`, visible only inside agent task
runs): reassign the _current task_ to a peer agent and let it continue, distinct
from `spawn_agent` (which keeps the supervisor and waits). Implementation:
re-`enqueue` (or update `agent_tasks.agent_id` + requeue) on the resource-aware
queue, respecting `delegatableAgents` and the depth cap, then return a terminal
"handed task #N to <agent>". Touches `agent-queue.ts` / `agents.ts` runtime only.
Ship this phase last; it's optional for the headline feature.

## Migration

**`src/storage/migrations/0034_conversation_bindings.sql`** (next in sequence):

```sql
CREATE TABLE conversation_bindings (
  chat_id    INTEGER PRIMARY KEY,         -- one active agent per conversation
  agent_id   INTEGER NOT NULL,
  set_by     TEXT NOT NULL,               -- 'user' | 'handoff:<agentName>'
  created_at INTEGER NOT NULL
);
```

No FK cascade — follow the 0032 precedent: `start.ts` already wraps
`agentRegistry.remove` (for `memory.forgetAgent`); extend that wrapper to also
call `router.onAgentRemoved(id)`. Keeps the delete cleanup in one place and obeys
the "no add-column-if-missing / never edit a shipped migration" invariant.

## Surfaces

### Telegram — `src/adapters/binding-commands.ts` (new)

Copy the `skill-commands.ts` / `standing-commands.ts` harness shape:

- `/bind <agent>` — bind this chat to an agent (validates the name against the
  fleet; rejects module/skill-origin agents? no — any fleet agent is bindable).
  No-arg `/bind` prints the current binding.
- `/unbind` — restore the default Modulus persona.

Register the command names in `CORE_COMMANDS` in `telegram.ts` so the dispatcher
leaves them to the surface. Confirm a bound chat shows its persona in `/status` or
the command's echo.

### Panel — `routes/agents.ts` + `web/agents.jsx`

- `GET /api/agents/bindings` → `[{chatId, agentId, agentName, setBy}]`
- `POST /api/agents/bindings` `{chatId, agentName}` → bind
- `DELETE /api/agents/bindings/:chatId` → unbind
- Agents tab gains a **Channels** card: list current bindings, and a selector to
  bind the **panel Dashboard chat** to an agent (so "chat with a specific agent in
  the browser" is one click; the default Modulus agent is the unbound default).

## Invariants honored

- **Deterministic prefix / KV cache:** one orchestrator per agent, memoized; no
  prefix reordering. The main orchestrator is untouched when a chat is unbound.
- **Grant intersection:** a bound agent's chat tools = its allowlist ∩ chatTools;
  handoff never widens a grant; agent-only control-plane tools stay hidden.
- **Confirm/owner fail-closed:** bound-agent chat turns run on the same
  confirm-bus + surface confirm renderer as the main orchestrator — no new path.
- **One heavy model resident:** unchanged; if a user binds a `reason`-profile
  agent to a chat, the governor still owns residency. Default Modulus stays light;
  document the cost of binding a heavy persona.
- **Migrations:** new numbered file; delete-cleanup via the existing `remove`
  wrapper, not an FK cascade.

## Tests (node:test + FakeLLM + temp SQLite, copy nearest neighbors)

- `conversation-routing.test.ts` — bind/unbind/boundAgentId/list; `orchestratorFor`
  returns the per-agent orchestrator vs default; cache invalidation on
  update/remove; auto-unbind on agent delete.
- `chat-dispatch.test.ts` (extend) — a bound chat drives the agent's persona
  (assert the FakeLLM saw the agent's `systemPrompt`); unbound uses the default.
- `agent-handoff.test.ts` — handoff re-binds; respects `delegatableAgents`;
  ping-pong cap; refuses unknown target; refuses from a task chatId; `handoff_task`
  reassigns and requeues.
- `binding-commands.test.ts` — `/bind`, `/bind <agent>`, `/unbind` parse + registry
  writes (copy `skill-commands.test.ts`).
- `routes/agents.test.ts` (extend) — bindings CRUD; binding a missing agent 404s.

## Phases (each ends green; desktop dist re-synced at the end per CLAUDE.md)

- **A.** Migration `0034` + `ConversationRouter` (store + cache, no orchestrator
  factory yet) + tests.
- **B.** Per-agent chat-orchestrator factory + `resolveOrchestrator` hook in
  `chat-dispatch.ts` + wire `router.orchestratorFor` in `start.ts` (Telegram +
  module dispatcher) + extend the `remove` wrapper + tests.
- **C.** `handoff` tool (`agent-handoff.ts`) + ping-pong guard + register in the
  chat registry / hide from task runs in `start.ts` + tests.
- **D.** Telegram `binding-commands.ts` + `CORE_COMMANDS` + tests.
- **E.** Panel bindings routes + `agents.jsx` Channels card + tests.
- **F.** (Optional) `handoff_task` background reassignment via queue/runtime + tests.
- **Docs.** Update `blueprint.md` §3 (the Modulus Agent) to document bindings +
  handoff; flip the roadmap memory; re-sync staging + publish desktop dist.

## Success criteria

- `/bind researcher` (or the panel Channels card) makes that chat answer as the
  researcher — its prompt, its tools, its memory namespace — and `/unbind` restores
  the default Modulus agent, all without a restart.
- The default Modulus agent can `handoff` a live chat to a specialist; the next
  user message is answered by the specialist; a bounce loop is capped.
- A worker in a bound chat never reaches a tool outside its allowlist ∩ chatTools;
  confirm-tier tools still prompt on the originating surface.
- Deleting a bound agent auto-unbinds its chats (no dangling persona).

## Status (implemented — Plan 1 complete)

**All phases A–F done**, full gate green (977 tests, 974 pass / 3 expected Windows
skips), desktop dist re-synced (staging + publish). Bindings + handoff work
end-to-end on Telegram **and** the panel; an agent can hand its whole task to a
peer with `handoff_task`.

- `ConversationRouter.orchestratorFor` returns the full `Orchestrator` (not just
  `HostOrchestrator`) — the panel chat's `thinking` chunk needs it, and it sets up
  routing `stop`/`newChat` through the router later.
- **Phase F — `handoff_task`** ([agent-handoff.ts](../../src/core/agent-handoff.ts)):
  **safe by construction.** It never reassigns/requeues the running task (the
  double-run hazard) — it enqueues a _fresh successor_ for the target carrying the
  goal, the original's notify chat, the caller's grant ceiling (no privilege
  escalation), and depth+1 (chains bounded like delegation). The caller's run then
  finishes on its own; the tool is `selfReplying` and its description tells the
  model its work is done. Agent-run only (hidden from chat + bound agents).
- **Known limitation (not a safety gap):** `/stop`·`/newchat`·`/lasterror` on both
  surfaces still target the _default_ orchestrator instance, so cancelling an
  in-flight **bound** turn won't abort it. Fix = route those through
  `router.orchestratorFor(chatId)` too (the type now allows it). Small follow-up,
  outside Plan 1's scope.
