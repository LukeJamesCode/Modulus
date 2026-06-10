-- 0025_module_npm_deps: record the exact npm dependency versions a heavy module
-- installed into its own folder, so `modulus status` can report what's pinned
-- without re-resolving node_modules. Stored as a JSON object {pkg: version};
-- NULL for the common case of a module that declares no npm deps. Additive
-- column (new migration, never an edit to 0002/0023) so the applied checksum
-- stays stable.

ALTER TABLE module_state ADD COLUMN npm_deps TEXT;
