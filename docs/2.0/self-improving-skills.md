# 2.0.0 Plan 2 — Approval-gated self-improving skills

**Thesis (carried from 1.5.0): a skill is data, never code.** Self-improvement
must not break that. An agent (or the user) can **propose** a new skill or an edit
to an existing one. The proposal is pure data; it is held off-disk, run through
the same `assertNoExecutableContent` gate, and **only written into the live skills
dir after the owner approves**. The model can rewrite _guidance_; it can never
write executable code, and it can never grant itself a tool. This is Modulus's
answer to the Hermes/Nous "self-writing skills" pitch — with a human gate and the
code-free guarantee intact.

This bundle is isolated to the skills subsystem — no overlap with Plan 1's
agent-routing files.

## What "self-improving" is allowed to change

A proposal can set, for one skill: the `summary`, the `SKILL.md` playbook body,
the `tools` allowlist (names of **existing** tools only), `intent_pattern`, and
the declared `agents`. It can **never** add code, a `node_modules/`, a
`migrations/`, or an `entrypoints` key — the same closed list `installer.ts`
already enforces. Crucially, a skill's only capability stays the intersection of
its `tools` with what's _installed and permitted_ (the 1.5.0 activation rule), so
rewriting instructions can sharpen behavior but never widen reach.

## Migration

**`src/storage/migrations/0035_skill_proposals.sql`** (after Plan 1's 0034; if
Plan 2 ships first it's 0034 — renumber to whatever is next at build time):

```sql
CREATE TABLE skill_proposals (
  id            INTEGER PRIMARY KEY,
  skill_name    TEXT NOT NULL,
  base_version  TEXT,                          -- version being edited; NULL = brand-new skill
  manifest_json TEXT NOT NULL,                 -- the proposed skill.json
  instructions  TEXT NOT NULL,                 -- the proposed SKILL.md
  rationale     TEXT NOT NULL,                 -- why; shown to the owner verbatim
  proposed_by   TEXT NOT NULL,                 -- 'agent:<name>' | 'user'
  status        TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | superseded
  created_at    INTEGER NOT NULL,
  decided_at    INTEGER,
  decided_by    TEXT                            -- 'telegram' | 'panel'
);
```

## Core — `src/core/skill-improve.ts` (new)

Mirrors the shape of `agent-approvals.ts`, but proposals are **async review
items**, not parked live tool calls — so there is no waiter promise. The proposing
tool returns immediately; the owner decides later.

- **`SkillProposalStore`** — `create`, `get`, `listPending`, `listRecent`,
  `decide(id, approved, by)`, `supersedePendingFor(skillName)` (a fresh proposal
  for the same skill marks older pending ones `superseded`), `expireAllPending`
  (startup hygiene, like approvals).
- **`propose_skill` tool** (`tier: 'auto'` — proposing is harmless; the **write**
  is what's gated). Args: `name`, `summary`, `instructions` (SKILL.md body),
  `tools` (string[]), `intent_pattern?`, `rationale`, `mode` (`'new' | 'edit'`).
  Handler:
  1. Validate `name` against `SKILL_NAME_RE`; `summary` non-empty; `instructions`
     within `MAX_SKILL_INSTRUCTIONS_BYTES`; `intent_pattern` within
     `MAX_INTENT_PATTERN_LEN` and compilable; warn (don't fail) on unknown tool
     names (activation intersection is the real guard).
  2. Build the proposed `skill.json` (`kind:'skill'`, `modulus: '>=<host
major.minor>'`).
  3. Write the two files into a **temp staging dir** and run
     `assertNoExecutableContent` over it — the code-free gate at _propose_ time
     (defense in depth; instructions is `.md`, but the gate is the guarantee).
  4. `supersedePendingFor(name)`, insert a `pending` row, fire the notifier.
  5. Return: _"Proposed skill '<name>' — waiting for your approval."_ (No block.)
- **`commitProposal(id)`** — on approval: write `skill.json` + `SKILL.md` into a
  temp dir, run `assertNoExecutableContent` **again** (commit-time gate), then
  `commitSkill` (installer) into the skills root. The existing skill **watcher
  hot-loads it**; `ensureStateRow` creates the `skill_state` row for a new skill;
  for an edit, the version bumps. The loader runs the gate a **third** time at
  load. Three checkpoints, one guarantee.
- **`ProposalManager`** — thin: holds the notifier, exposes `approve(id)` /
  `reject(id)` that call `decide` then (on approve) `commitProposal`. No parked
  promise, no poll loop.

## Installer reuse — `src/core/installer.ts`

Reuse `assertNoExecutableContent`, `stageSkill`/`commitSkill`, and the
`MAX_SKILL_INSTRUCTIONS_BYTES` / `MAX_INTENT_PATTERN_LEN` caps. Add at most one
small helper, `writeSkillBundle(dir, manifest, instructions)`, used by both the
propose-time stage and commit; otherwise no installer change.

## Surfaces

### Telegram — extend `src/adapters/skill-commands.ts`

- Approval notifier sends a Yes/No inline button (reuse the `onCallback`
  `cb:<prefix>:<...>` pattern already used for confirms/approvals).
- `/proposals` — list pending proposals (name, proposed_by, rationale).
- Tapping **Yes** → `ProposalManager.approve` → commit + hot-load; **No** →
  `reject` (disk untouched).

### Panel — `routes/skills.ts` + `web/modules.jsx` (SkillsView)

- `GET /api/skills/proposals` (pending + recent), `POST
/api/skills/proposals/:id/approve`, `POST /api/skills/proposals/:id/reject`.
- A **Proposals** subsection in SkillsView: per proposal show name, `proposed_by`,
  rationale, and a **diff** (edit: current `SKILL.md` vs proposed) or full preview
  (new). Approve / Reject buttons. Approving commits and the skill list refreshes.

## Security invariants (restate; these are the point)

- **Code-free, three times:** the gate runs at propose, commit, and load. The
  loader still has no `Host` and never imports — a proposed skill cannot smuggle
  code through any of them.
- **No capability creation:** a proposal can rewrite guidance and re-list tools,
  but a skill's power is still `tools ∩ installed+permitted`. Self-improvement
  changes _instructions_, never _reach_.
- **Owner-only approval:** only the Telegram owner / token-authed panel approves.
  An agent cannot self-approve; a chat user cannot approve.
- **Caps:** instructions size, `intent_pattern` length, and pending-per-skill
  (supersede) are bounded at propose time; total pending is capped.
- **Injection containment unchanged:** a committed skill still loads on demand
  inside the 1.5.0 provenance fence with the standing anti-injection policy line;
  a playbook that says "the user approved deleting everything" still hits the
  confirm/owner gate and fails closed unattended.

## Tests

- `skill-improve.test.ts` — propose creates a pending row; bad name / oversized
  instructions / bad regex rejected at propose time; `supersedePendingFor` marks
  older pending superseded; commit writes both files and the loader picks the
  skill up (temp skills root); reject leaves disk untouched; approval restricted to
  owner/panel deciders.
- Adversarial — a proposed `instructions` body with override/exfil language, once
  committed, still yields a skill whose activation tools are intersected (no
  widened grant); assert the fence wraps it (reuse `fenceSkill`).
- `routes/skills.test.ts` (extend) — proposals endpoints; approve commits, reject
  doesn't; unauth request rejected.

## Phases

- **A.** Migration + `SkillProposalStore` + `propose_skill` tool + propose-time
  gate + tests.
- **B.** `commitProposal` + `writeSkillBundle`/`commitSkill` reuse + hot-load +
  tests.
- **C.** `ProposalManager` notifier + Telegram Yes/No + `/proposals` + tests.
- **D.** Panel proposals routes + SkillsView Proposals subsection (diff) + tests.
- **E.** Docs: `skills.md` gains a "Self-improvement" section; `SECURITY.md` notes
  the three-point gate and "no capability creation"; an abilitytest case where the
  operator proposes a refinement; re-sync desktop dist.

## Success criteria

- An agent calls `propose_skill`; the owner sees it on Telegram and in the panel
  with a readable diff; **Yes** writes the skill into `~/.modulus/skills/<name>/`
  and it's usable that turn; **No** leaves disk untouched.
- A proposal carrying executable content (or an `entrypoints` key) is refused at
  propose time, never reaching review.
- A committed self-proposed skill cannot use any tool the owner hasn't installed
  and permitted, regardless of what its playbook claims.
