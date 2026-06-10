-- 0026_rename_agent_origin_prefix: module-provided fleet agents recorded their
-- provenance as 'ext:<name>'. The user-facing concept is now "module", so the
-- persisted prefix becomes 'module:<name>' to match the loader, which writes and
-- sweeps the new prefix. Additive migration (never an edit to 0022) that rewrites
-- existing rows in place; 'ext:' is 4 chars, so substr(origin, 5) is the name.
-- Task history survives because the agent id is unchanged — only the prefix moves.

UPDATE agents SET origin = 'module:' || substr(origin, 5) WHERE origin LIKE 'ext:%';
