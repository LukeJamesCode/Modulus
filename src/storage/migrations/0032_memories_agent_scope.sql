-- 0032_memories_agent_scope: per-agent memory namespaces (v1.4.0).
--
-- NULL = global/shared, the hive mind of user truth (explicit `remember` and
-- extracted user facts). A value scopes a row to one agent's private namespace
-- (its promoted findings). An agent run recalls global ∪ its own; the main chat
-- recalls global only. Plain nullable INTEGER (no REFERENCES on ADD COLUMN —
-- SQLite forbids a non-NULL-default FK clause there); agent deletion cleans up
-- its rows in code (see memory.forgetAgent). See src/core/memory.ts.
ALTER TABLE memories ADD COLUMN agent_id INTEGER;

CREATE INDEX idx_memories_scope ON memories (agent_id, importance, last_used_at);
