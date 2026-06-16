-- 0033_skill_state: declarative-skill lifecycle, mirroring module_state.
--
-- A skill is pure prompt data (skill.json + SKILL.md), installed through the
-- same pinned, consent-gated pipeline as a module but held to a stricter,
-- code-free contract. Its lifecycle state lives here — kept in its own table so
-- the module loader never touches a skill and the skill loader never touches a
-- module. Skills carry no settings (their only capability is the consented tool
-- allowlist), so there is no companion skill_settings table.
--
-- Per-skill rows are upserted on load and flipped by the panel/Telegram
-- enable/disable/uninstall flow, exactly like module_state.

CREATE TABLE skill_state (
  name TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  installed_at INTEGER NOT NULL,
  last_loaded_at INTEGER
);
