-- 0034_conversation_bindings: channel→agent bindings (v2.0.0).
--
-- One conversation (a surface chatId — a Telegram chat, a Discord channel, the
-- panel Dashboard) can be bound to a fleet agent, so turns on that chat run as
-- that agent's persona instead of the default Modulus agent. A user sets a
-- binding (/bind, panel); an agent rewrites it via the handoff tool. One active
-- agent per conversation, hence chat_id is the primary key.
--
-- No REFERENCES/cascade: matching the 0032 precedent, agent deletion cleans up
-- its bindings in code (start.ts wraps agentRegistry.remove → router.onAgentRemoved)
-- so the delete cleanup lives in one place. See src/core/conversation-routing.ts.
CREATE TABLE conversation_bindings (
  chat_id    INTEGER PRIMARY KEY,
  agent_id   INTEGER NOT NULL,
  set_by     TEXT NOT NULL,         -- 'user' | 'handoff:<agentName>'
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_conversation_bindings_agent ON conversation_bindings (agent_id);
