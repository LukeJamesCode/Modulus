-- 0002_extensions: extension state + per-extension settings.
--
-- The loader records which extensions exist on this install and whether the
-- user has enabled each one. Settings live in a typed key/value store keyed
-- by extension; the loader validates writes against each extension's
-- settings.schema.json before they land.
--
-- Per-extension SQLite migrations get their own `_ext_<name>_migrations`
-- table created at extension load time — they aren't recorded here.

CREATE TABLE extension_state (
  name TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  installed_at INTEGER NOT NULL,
  last_loaded_at INTEGER
);

CREATE TABLE extension_settings (
  extension TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (extension, key)
);
