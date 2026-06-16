// Pure command logic for the Telegram standing-order surface: /standing [add |
// cancel]. A standing order here is agentic — "every beat, have <agent> do X and
// report back" — which is the useful chat case; notify-only/change-detect orders
// are managed from the panel where cadence and conditions can be tuned.

import type { AgentRegistry } from '../core/agents.js';
import type { StandingOrderStore, StandingOrder } from '../core/standing-orders.js';

export interface StandingDeps {
  store: StandingOrderStore;
  registry: AgentRegistry;
}

const USAGE = [
  'Standing orders — a watch the heartbeat runs on its own.',
  'Add:    /standing add <agent>, <what to do>',
  'List:   /standing',
  'Cancel: /standing cancel <id>',
].join('\n');

function describeOrder(o: StandingOrder, agentName: string): string {
  const cadence = o.cron ? `\`${o.cron}\`` : 'each beat';
  return `#${o.id} · ${agentName} (${cadence}) — ${o.instruction}`;
}

function list(deps: StandingDeps, chatId: number): string {
  const rows = deps.store.list({ chatId, active: true, limit: 50 });
  if (rows.length === 0) {
    return `No standing orders yet.\n\n${USAGE}`;
  }
  const lines = rows.map((o) => {
    const name = o.agentId != null ? (deps.registry.get(o.agentId)?.name ?? `agent #${o.agentId}`) : 'notify';
    return describeOrder(o, name);
  });
  return ['🛰️ Standing orders:', ...lines, '', 'Cancel one with /standing cancel <id>.'].join('\n');
}

function add(deps: StandingDeps, chatId: number, rest: string): string {
  const i = rest.indexOf(',');
  if (i === -1) return `Usage: /standing add <agent>, <what to do>`;
  const agentName = rest.slice(0, i).trim();
  const instruction = rest.slice(i + 1).trim();
  if (!agentName || !instruction) return `Usage: /standing add <agent>, <what to do>`;
  const agent = deps.registry.getByName(agentName);
  if (!agent) return `No agent named '${agentName}'. Run /agents to see them.`;
  const order = deps.store.create({ instruction, agentId: agent.id, notifyChatId: chatId });
  return (
    `🛰️ Standing order #${order.id} — ${agent.name} will ${instruction} on each heartbeat ` +
    `and message you the result. Cancel with /standing cancel ${order.id}.`
  );
}

function cancel(deps: StandingDeps, chatId: number, rest: string): string {
  const id = Number.parseInt(rest.trim(), 10);
  if (!Number.isInteger(id) || id <= 0) return 'Usage: /standing cancel <id>';
  return deps.store.removeForChat(chatId, id)
    ? `Cancelled standing order #${id}.`
    : `No standing order #${id} in this chat. Run /standing to see them.`;
}

// /standing [add <agent>, <what> | cancel <id>] — defaults to the list.
export function handleStanding(deps: StandingDeps, chatId: number, arg: string): string {
  const trimmed = arg.trim();
  if (!trimmed) return list(deps, chatId);
  const sep = trimmed.search(/\s/);
  const sub = (sep === -1 ? trimmed : trimmed.slice(0, sep)).toLowerCase();
  const rest = sep === -1 ? '' : trimmed.slice(sep + 1).trim();
  if (sub === 'add') return add(deps, chatId, rest);
  if (sub === 'cancel' || sub === 'remove') return cancel(deps, chatId, rest);
  if (sub === 'list') return list(deps, chatId);
  return `Unknown option '${sub}'.\n\n${USAGE}`;
}
