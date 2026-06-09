-- Provenance for fleet agents. NULL = user-created (the editor). A module-
-- provided agent (manifest v2 `agents` entry) carries 'ext:<module-name>' so
-- the loader can upsert it on load, remove it on uninstall, and the panel can
-- mark it module-owned (not user-deletable while the module is installed).
ALTER TABLE agents ADD COLUMN origin TEXT;
