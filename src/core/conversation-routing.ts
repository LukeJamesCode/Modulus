// Conversation routing — which agent persona is active for a given chat.
//
// A surface reduces every inbound message to a numeric chatId (a Telegram chat,
// a Discord channel, the panel Dashboard). Unbound, that chat runs against the
// default Modulus orchestrator. Bound, it runs against the bound agent's own
// interactive chat orchestrator — that agent's system prompt, tools (its
// allowlist ∩ chat tools), and private memory namespace.
//
// Two writers share this state: the user sets a binding statically (/bind, the
// panel Channels card), and an agent rewrites it dynamically via the handoff
// tool (set_by = 'handoff:<agentName>'). Reads happen on the chat hot path
// (chat-dispatch's resolveOrchestrator), so the chatId→agentId map is cached in
// memory and the per-agent orchestrator is memoized — one orchestrator per agent
// keeps each persona's deterministic prompt prefix stable for the KV cache.
//
// This file owns only the routing STATE. The orchestrator factory (which closes
// over createOrchestrator + the filtered chat tool registry) is injected from
// start.ts, so nothing here imports the LLM or tool wiring.

import type { DB } from '../storage/db.js';
import type { Logger } from '../util/log.js';
import type { Orchestrator } from './orchestrator.js';
import type { AgentDefinition, AgentRegistry } from './agents.js';

export interface ConversationBinding {
  chatId: number;
  agentId: number;
  // Resolved live from the registry; absent when the agent was deleted out from
  // under a stale row (such a binding is swept on read).
  agentName: string;
  setBy: string; // 'user' | 'handoff:<agentName>'
  createdAt: number;
}

// Builds the interactive chat orchestrator for one agent persona. Injected from
// start.ts; the router memoizes the result per agent id and invalidates it when
// the agent is updated or removed.
export type ChatOrchestratorFactory = (agent: AgentDefinition) => Orchestrator;

export interface ConversationRouterOptions {
  db: DB;
  registry: AgentRegistry;
  log: Logger;
  // The unbound persona — the existing main Modulus orchestrator.
  defaultOrchestrator: Orchestrator;
  orchestratorFactory: ChatOrchestratorFactory;
}

export interface ConversationRouter {
  // Bind a chat to an agent. Returns the binding, or undefined when no agent
  // with that id exists (nothing is written).
  bind(chatId: number, agentId: number, setBy: string): ConversationBinding | undefined;
  unbind(chatId: number): boolean;
  boundAgentId(chatId: number): number | null;
  binding(chatId: number): ConversationBinding | undefined;
  list(): ConversationBinding[];
  // The orchestrator a turn on this chat should run against: the bound agent's
  // chat orchestrator, or the default when unbound (or when the bound agent has
  // since been deleted — that stale binding is swept here).
  orchestratorFor(chatId: number): Orchestrator;
  // Delete every binding to this agent and drop its memoized orchestrator. Wired
  // into start.ts's agentRegistry.remove wrapper.
  onAgentRemoved(agentId: number): void;
  // The agent's persona/tools changed — drop the memoized orchestrator so the
  // next turn rebuilds it. Bindings are untouched.
  onAgentUpdated(agentId: number): void;
}

interface BindingRow {
  chat_id: number;
  agent_id: number;
  set_by: string;
  created_at: number;
}

export function createConversationRouter(opts: ConversationRouterOptions): ConversationRouter {
  const log = opts.log.child({ mod: 'conversation-routing' });

  const upsert = opts.db.prepare(
    `INSERT INTO conversation_bindings (chat_id, agent_id, set_by, created_at)
     VALUES (@chat_id, @agent_id, @set_by, @created_at)
     ON CONFLICT(chat_id) DO UPDATE SET
       agent_id = excluded.agent_id, set_by = excluded.set_by, created_at = excluded.created_at`,
  );
  const deleteByChat = opts.db.prepare(`DELETE FROM conversation_bindings WHERE chat_id = ?`);
  const deleteByAgent = opts.db.prepare(`DELETE FROM conversation_bindings WHERE agent_id = ?`);
  const selectAll = opts.db.prepare(
    `SELECT chat_id, agent_id, set_by, created_at FROM conversation_bindings ORDER BY created_at`,
  );

  // chatId -> agentId, warm at boot so the hot path never hits the DB.
  const cache = new Map<number, number>();
  for (const r of selectAll.all() as BindingRow[]) cache.set(r.chat_id, r.agent_id);
  // agentId -> orchestrator, memoized; rebuilt on update/remove.
  const orchCache = new Map<number, Orchestrator>();

  function rowToBinding(r: BindingRow): ConversationBinding | undefined {
    const agent = opts.registry.get(r.agent_id);
    if (!agent) return undefined;
    return {
      chatId: r.chat_id,
      agentId: r.agent_id,
      agentName: agent.name,
      setBy: r.set_by,
      createdAt: r.created_at,
    };
  }

  function sweepStale(chatId: number): void {
    deleteByChat.run(chatId);
    cache.delete(chatId);
    log.info('swept stale binding (agent gone)', { chatId });
  }

  return {
    bind(chatId, agentId, setBy) {
      const agent = opts.registry.get(agentId);
      if (!agent) return undefined;
      const createdAt = Date.now();
      upsert.run({ chat_id: chatId, agent_id: agentId, set_by: setBy, created_at: createdAt });
      cache.set(chatId, agentId);
      log.info('bound chat to agent', { chatId, agent: agent.name, setBy });
      return { chatId, agentId, agentName: agent.name, setBy, createdAt };
    },

    unbind(chatId) {
      const had = cache.delete(chatId);
      deleteByChat.run(chatId);
      if (had) log.info('unbound chat', { chatId });
      return had;
    },

    boundAgentId(chatId) {
      return cache.get(chatId) ?? null;
    },

    binding(chatId) {
      const agentId = cache.get(chatId);
      if (agentId === undefined) return undefined;
      const agent = opts.registry.get(agentId);
      if (!agent) {
        sweepStale(chatId);
        return undefined;
      }
      const row = opts.db
        .prepare(
          `SELECT chat_id, agent_id, set_by, created_at FROM conversation_bindings WHERE chat_id = ?`,
        )
        .get(chatId) as BindingRow | undefined;
      return row ? rowToBinding(row) : undefined;
    },

    list() {
      const out: ConversationBinding[] = [];
      for (const r of selectAll.all() as BindingRow[]) {
        const b = rowToBinding(r);
        if (b) out.push(b);
        else sweepStale(r.chat_id);
      }
      return out;
    },

    orchestratorFor(chatId) {
      const agentId = cache.get(chatId);
      if (agentId === undefined) return opts.defaultOrchestrator;
      const agent = opts.registry.get(agentId);
      if (!agent) {
        // The bound agent was deleted without going through onAgentRemoved
        // (e.g. a raw DB delete); fall back cleanly and drop the stale row.
        sweepStale(chatId);
        orchCache.delete(agentId);
        return opts.defaultOrchestrator;
      }
      let orch = orchCache.get(agentId);
      if (!orch) {
        orch = opts.orchestratorFactory(agent);
        orchCache.set(agentId, orch);
      }
      return orch;
    },

    onAgentRemoved(agentId) {
      const removed = deleteByAgent.run(agentId).changes;
      for (const [chatId, boundId] of cache) if (boundId === agentId) cache.delete(chatId);
      orchCache.delete(agentId);
      if (removed > 0) log.info('dropped bindings for removed agent', { agentId, count: removed });
    },

    onAgentUpdated(agentId) {
      orchCache.delete(agentId);
    },
  };
}
