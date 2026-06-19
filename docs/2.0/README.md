# Modulus 2.0.0 — "Bigger Bets" plans

The 2.0.0 milestone from the roadmap: **channel→agent bindings, agent-to-agent
handoff, approval-gated self-improving skills, MCP module, `npx modulus`.**

These are five features but **four plans**. The rule: features that edit the same
files ship as one plan; independent features get their own. The overlap matrix
below is why bindings + handoff are one document and the rest stand alone.

## File-overlap matrix

| File / surface                                   | Bindings | Handoff | Self-improving skills | MCP module | npx |
| ------------------------------------------------ | :------: | :-----: | :-------------------: | :--------: | :-: |
| new migration                                    |    ▣     |    ▣    |           ●           |     –      |  –  |
| `src/core/chat-dispatch.ts`                      |    ▣     |    ▣    |           –           |     –      |  –  |
| `src/core/agents.ts` (registry + runtime)        |    ▣     |    ▣    |           –           |     –      |  –  |
| new conversation-routing core file               |    ▣     |    ▣    |           –           |     –      |  –  |
| `src/core/agent-queue.ts`                         |    –     |    ▣    |           –           |     –      |  –  |
| `src/adapters/telegram.ts` + routing commands    |    ▣     |    ▣    |           –           |     –      |  –  |
| panel `routes/agents.ts` + `agents.jsx`          |    ▣     |    ▣    |           –           |     –      |  –  |
| `src/core/skills.ts` / `skill-tools.ts`          |    –     |    –    |           ●           |     –      |  –  |
| `src/core/installer.ts` / `agent-approvals.ts`   |    –     |    –    |           ●           |     –      |  –  |
| panel `routes/skills.ts` + `modules.jsx`         |    –     |    –    |           ●           |     –      |  –  |
| `modules/modulus-mcp/**`                         |    –     |    –    |           –           |     ◆      |  –  |
| `package.json` / `src/cli/index.ts` / `scripts/` |    –     |    –    |           –           |     –      |  ★  |

`▣` = the bindings+handoff bundle, `●` = skills bundle, `◆` = MCP, `★` = npx.
The three glyph groups touch disjoint file sets — clean parallel work, no merge
conflicts.

## The four plans

1. **[conversation-routing.md](conversation-routing.md)** — channel→agent bindings
   **and** agent-to-agent handoff. Bundled: both add and read one new "active
   agent for a conversation" layer (`chatId → agentId`), and both edit
   `chat-dispatch.ts`, `agents.ts`, the Telegram surface, and the panel Agents
   tab. A user-set binding and an agent-initiated handoff are the static and
   dynamic writers of the same routing state.
2. **[self-improving-skills.md](self-improving-skills.md)** — an agent (or the
   user) can propose a new or improved skill; the proposal is **data**, staged
   through the existing code-free gate, and only written to disk after the owner
   approves. Isolated to the skills subsystem.
3. **[mcp-module.md](mcp-module.md)** — a first-party `modulus-mcp` module that
   bridges Model Context Protocol servers into the tool registry. Target: **zero
   core changes** (the module API already exposes everything it needs); if a core
   change is unavoidable it's a Host-surface gap to fix, per North Star #3.
4. **[npx-distribution.md](npx-distribution.md)** — `npx modulus` and a one-line
   install story, including the native-`better-sqlite3` problem that the dev box
   already feels. Packaging + CLI bootstrap only.

## Sequencing & "most important first"

Build order, most important first:

1. **Conversation routing** (plan 1) — the headline 2.0 capability and the
   biggest shared-infra payoff: agents stop being background workers you dispatch
   to and become first-class entities you can *talk to on a channel* and that can
   *hand a conversation to each other*. Largest leverage, listed first in the
   roadmap, and the foundation the other surfaces lean on. **Start here.**
2. **MCP module** (plan 3) — the single biggest capability multiplier; opens the
   whole MCP ecosystem with no core risk.
3. **npx distribution** (plan 4) — adoption (North Star #1: an everyday person can
   run it), independent and shippable any time.
4. **Self-improving skills** (plan 2) — the highest-risk bet (a model proposing
   its own instructions); do it last, on top of the now-proven approval and
   code-free-gate machinery.

Each plan ends green (`npm run lint && npm run typecheck && npm test`) and, per
CLAUDE.md, re-syncs the desktop dist when `src/` changed. None edits a shipped
migration; each new table is a new numbered file continuing from `0033`.
</content>
</invoke>
