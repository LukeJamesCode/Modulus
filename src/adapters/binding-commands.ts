// Pure command logic for channel→agent bindings on Telegram (v2.0.0): /bind
// <agent> makes this chat talk to a specific fleet agent (its persona, tools,
// and memory) instead of the default Modulus assistant; /unbind restores the
// default. The same binding state an agent rewrites at runtime via the handoff
// tool — these commands are the user-driven, static writer.
//
// Pure (string in, string out) like skill-commands.ts: the adapter wires them to
// bot.command and supplies the chat id; tests call them directly.

import type { AgentRegistry } from '../core/agents.js';
import type { ConversationRouter } from '../core/conversation-routing.js';

export interface BindingDeps {
  router: Pick<ConversationRouter, 'bind' | 'unbind' | 'boundAgentId' | 'binding'>;
  registry: Pick<AgentRegistry, 'getByName'>;
}

// /bind [<agent>] — no arg shows the current binding; an arg binds this chat.
export function handleBind(deps: BindingDeps, arg: string, chatId: number): string {
  const name = arg.trim();
  if (!name) {
    const current = deps.router.binding(chatId);
    return current
      ? `This chat talks to '${current.agentName}'. Use /bind <agent> to switch, or /unbind for the default assistant.`
      : 'This chat uses the default Modulus assistant. Bind a fleet agent with /bind <agent>.';
  }
  const agent = deps.registry.getByName(name);
  if (!agent) {
    return `No agent named '${name}'. See your fleet in the Agents tab, or /hire one.`;
  }
  deps.router.bind(chatId, agent.id, 'user');
  return `This chat now talks to '${agent.name}'. Use /unbind to return to the default assistant.`;
}

// /unbind — restore the default Modulus assistant for this chat.
export function handleUnbind(deps: BindingDeps, chatId: number): string {
  if (deps.router.boundAgentId(chatId) === null) {
    return 'This chat already uses the default Modulus assistant.';
  }
  deps.router.unbind(chatId);
  return 'Unbound — this chat is back to the default Modulus assistant.';
}
