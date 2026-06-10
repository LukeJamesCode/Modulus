-- 0023_rename_extension_tables: the user-facing concept is now "module", so the
-- two extension tables and the settings table's owning-key column are renamed to
-- match. Additive (a new migration, never an edit to 0002) so the checksum of
-- the already-applied schema stays stable. ALTER ... RENAME preserves existing
-- rows, so enabled/installed state and per-module settings survive the rename.

ALTER TABLE extension_state RENAME TO module_state;
ALTER TABLE extension_settings RENAME TO module_settings;
ALTER TABLE module_settings RENAME COLUMN extension TO module;
