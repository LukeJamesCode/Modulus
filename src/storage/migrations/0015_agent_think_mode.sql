-- 0015_agent_think_mode: per-agent thinking mode.
--
-- Agents run unattended, so the choice of whether the model reasons can't be a
-- per-turn click like the chat tab's toggle — it lives on the agent record and
-- is applied to every turn the agent runs (see createAgentRuntime). 'auto'
-- keeps the prior behaviour (per-model default), so existing agents are
-- unchanged after this migration.

ALTER TABLE agents
  ADD COLUMN think_mode TEXT NOT NULL DEFAULT 'auto'
    CHECK (think_mode IN ('auto', 'on', 'off'));
