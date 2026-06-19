-- 0035_skill_proposals: approval-gated self-improving skills (v2.0.0).
--
-- An agent (or the user) PROPOSES a new skill or an edit to one. A proposal is
-- pure data — a skill.json + a SKILL.md body — held here, off the live skills
-- dir, until the owner approves. On approval it's written through the same
-- code-free gate as a marketplace skill and hot-loaded; rejection leaves disk
-- untouched. The model can rewrite guidance, never code, and never grant itself a
-- tool (a skill's reach stays tools ∩ installed+permitted). See
-- src/core/skill-improve.ts.
--
-- Unlike agent_approvals (which parks a live tool call that dies with the
-- process), a proposal is a durable review item: it survives a restart and waits
-- for a human, so there is no startup expiry.
CREATE TABLE skill_proposals (
  id            INTEGER PRIMARY KEY,
  skill_name    TEXT NOT NULL,
  base_version  TEXT,                            -- version being edited; NULL = brand-new skill
  manifest_json TEXT NOT NULL,                   -- the proposed skill.json
  instructions  TEXT NOT NULL,                   -- the proposed SKILL.md
  rationale     TEXT NOT NULL,                   -- why; shown to the owner verbatim
  proposed_by   TEXT NOT NULL,                   -- 'assistant' | 'agent:<name>' | 'user'
  status        TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | superseded
  created_at    INTEGER NOT NULL,
  decided_at    INTEGER,
  decided_by    TEXT                             -- 'telegram' | 'panel'
);

CREATE INDEX idx_skill_proposals_status ON skill_proposals (status, created_at);
