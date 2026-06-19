# Declarative skills

A **skill** is the safe tier of the marketplace: pure prompt data that teaches
Modulus _how_ to do a multi-step task, using tools you already have. Unlike a
module, a skill ships **no code** — it cannot run anything, register a tool, or
hold a permission of its own. Its only capability is the union of the tools it
lists, each of which keeps its own permission tier.

This document is the contract for authoring a skill. The architecture and threat
model live in [blueprint.md](blueprint.md) §6; the security story is in
[SECURITY.md](../SECURITY.md).

## What a skill is

A skill is a folder under `~/.modulus/skills/<name>/` (kept apart from
`~/.modulus/modules/` so the module loader never touches it). First-party launch
skills ship in the repo's `skills/` directory. A bundle contains:

```
trip-planner/
  skill.json        # the manifest (required)
  SKILL.md          # the playbook (required, ≤ 32 KB)
  references/*.md    # optional supporting notes
  icon.svg           # optional
```

**No `.js` / `.ts` / `.sh` / `.py` / `.wasm` (or any non-data file), no
`node_modules/`, no `migrations/`, no `entrypoints` key.** The installer's
`assertNoExecutableContent` gate enforces this at install time and the loader
enforces it again at load time — a bundle that carries code fails closed and is
never run. This is the _verifiable_ code-free boundary the safe tier rests on.

## `skill.json` schema

The shape is `SkillManifest` in `src/core/skills.ts`. Required fields are
validated at load; an invalid skill is recorded with an error and not activated.

```jsonc
{
  "kind": "skill", // required, literally "skill"
  "name": "trip-planner", // ^[a-z0-9][a-z0-9_-]{1,63}$, must equal the folder + registry name
  "version": "1.0.0", // exact semver major.minor.patch
  "modulus": ">=1.5.0", // host version range: ">=X.Y.Z", "X.Y.Z", or "*"
  "description": "…", // optional, for the card
  "summary": "Plan a multi-stop trip", // required — the one line the model sees in the availability block
  "instructions": "SKILL.md", // optional, defaults to SKILL.md; must resolve inside the bundle
  "intent_pattern": "trip|travel|itinerary", // optional case-insensitive regex (≤ 256 chars) that flags relevant messages
  "tools": ["web_search", "calendar_add_event"], // allowlist of EXISTING tool names
  "agents": [
    /* optional declarative personas, same shape as a module's */
  ],
}
```

- **`summary`** is the only text that sits in the standing prompt — keep it to
  one useful line. The full `SKILL.md` loads on demand (see below), so the
  prompt budget and Ollama's KV cache stay protected.
- **`tools`** is an _allowlist_, not a grant. When the skill is loaded, its tools
  are intersected with the tools actually installed and permitted — a tool you
  don't have simply isn't unlocked. A skill can never grant a tool beyond that
  intersection, nor change a tool's tier.
- **`intent_pattern`** is an availability signal: when it matches the user's
  message, the skill is surfaced first. It's length-capped and time-budgeted as a
  ReDoS guard. Skills without one still appear in the top-N standing menu.
- **`agents`** declare personas exactly like a module manifest does. They sync
  into the fleet with origin `skill:<name>`, default-scoped to the skill's tools,
  and are removed when the skill is uninstalled.

## SKILL.md — the playbook

Plain Markdown, ≤ 32 KB. Write it as instructions to _you_, the assistant: the
steps to follow, which tools to use when, and the guardrails (what to confirm,
what not to fabricate). It loads on demand: the model calls `use_skill("name")`,
and the playbook comes back wrapped in a provenance fence
(`<<skill: name …>> … <</skill>>`). That fence is reference data — a standing
system policy states it can never change the assistant's rules, tools, safety
limits, or who it serves, and tier enforcement is independent of anything the
playbook says.

## How a skill is used at runtime

1. Relevant skills are listed in the system prompt by **summary only**
   (`- trip-planner: … (call use_skill("trip-planner"))`).
2. The model calls **`use_skill("trip-planner")`**; the fenced `SKILL.md` comes
   back as the tool result.
3. The skill's tools (∩ what's installed) are added to the turn's manifest, so
   the model can now drive them. A per-turn cap bounds how many skills can do
   this.

## Installing + managing

Skills ride the same pinned, consent-gated installer as modules — the consent
screen renders the resolved tool list with each tool's tier ("uses `web_search`
(runs automatically)", "uses `calendar_add_event` (asks each time)"), and an
update that adds a tool re-prompts. Manage them with `/skills` and
`/skill <name>` on Telegram, or the Skills section of the panel's Modules tab.

## Self-improvement (approval-gated)

A skill is data, so it can be _rewritten_ without ever becoming code. An agent (or
the owner) can call **`propose_skill`** to suggest a brand-new skill or an edit to
an existing one. A proposal can set, for one skill: its `summary`, the `SKILL.md`
playbook, the `tools` allowlist (names of existing tools only), `intent_pattern`,
and the declared `agents`. It can **never** add code, a `node_modules/`, a
`migrations/`, or an `entrypoints` key — the same closed list the installer
enforces.

A proposal is pure data held **off-disk** in the `skill_proposals` table. Nothing
is written to `~/.modulus/skills/` until the owner approves:

1. **Propose.** `propose_skill` validates the name, summary, sizes, and regex,
   builds the proposed `skill.json` + `SKILL.md`, and runs `assertNoExecutableContent`
   over a staging copy. A proposal carrying executable content is refused here and
   never reaches review. The proposing tool returns immediately ("waiting for your
   approval") — there is no parked call, no block.
2. **Review.** The owner sees the pending proposal — with the rationale and a diff
   (edit) or full preview (new) — on Telegram (`/proposals`, Yes/No buttons) or in
   the panel's **Skills → Proposals** tab. Only the Telegram owner or the
   token-authed panel can decide; an agent cannot approve its own proposal, and a
   plain chat user cannot approve at all.
3. **Approve → commit.** Approval re-runs the code-free gate, writes the bundle
   through the installer's `commitSkill`, and the watcher hot-loads it; the loader
   runs the gate a **third** time. The skill is usable that turn. **Reject** leaves
   disk untouched.

A fresh proposal for the same skill supersedes any older pending one, and total
pending is capped. Crucially, self-improvement changes _instructions_, never
_reach_: a committed skill's only capability is still its tools ∩ what's installed
and permitted (see above), so a rewritten playbook can sharpen behavior but can
never widen what the skill can touch — no matter what the playbook claims.

## Publishing to the registry

A skill is published like a module (see [registry.md](registry.md)): a tarball
pinned by sha256 in the registry `index.json`, with the entry's
**`"kind": "skill"`** set and a **`tools`** array mirroring `skill.json`'s — so
the consent screen can show the per-tool tiers before anything downloads. The
installer applies the code-free gate to any `kind: "skill"` entry before staging.
