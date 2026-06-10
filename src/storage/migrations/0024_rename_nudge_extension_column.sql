-- 0024_rename_nudge_extension_column: the scheduler tags each persisted nudge
-- with the module that scheduled it. Following the extension->module rename,
-- that column moves from `extension` to `module` in both nudge tables. Additive
-- and in-place (ALTER ... RENAME COLUMN) so existing nudge history survives; no
-- index references the column, so nothing else needs rebuilding.

ALTER TABLE nudge_log RENAME COLUMN extension TO module;
ALTER TABLE deferred_nudges RENAME COLUMN extension TO module;
