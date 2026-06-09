// Human-in-the-loop approvals for risky agent actions.
//
// Background agent tasks run unattended, so a 'confirm'-tier tool call (or the
// built-in request_approval tool) can't just pop a prompt in a chat the way a
// live Telegram turn does. Instead the daemon PARKS the call here: it writes a
// pending agent_approvals row, asks the owner over Telegram (Yes/No buttons)
// and surfaces it in the control panel, then resolves the parked call once the
// row leaves 'pending'. There is no timeout — a risky step waits until a human
// answers (or the task is cancelled).
//
// Two processes touch the row: the DAEMON owns the parked promise and decides
// via the Telegram callback (in-process); the PANEL runs separately and decides
// by writing the row. So the manager resolves a waiter from either an in-process
// call (resolveFromTelegram) or a short DB poll that notices a panel decision —
// the same cross-process pattern the agent queue uses.

import type { DB } from '../storage/db.js';
import type { Logger } from '../util/log.js';
import type { ToolRegistry } from './tools.js';
import { REQUEST_APPROVAL_TOOL_NAME, type AgentRegistry } from './agents.js';

export type AgentApprovalStatus = 'pending' | 'approved' | 'rejected';
// Where a decision came from. 'cancelled' = the task was cancelled while parked;
// 'restart' = a daemon restart abandoned the parked call.
export type AgentApprovalDecider = 'telegram' | 'panel' | 'cancelled' | 'restart';

export interface AgentApproval {
  id: number;
  taskId: number;
  agentId: number | null;
  agentName: string;
  toolName: string;
  preview: string;
  args: Record<string, unknown> | null;
  status: AgentApprovalStatus;
  decidedBy: AgentApprovalDecider | null;
  createdAt: number;
  decidedAt: number | null;
}

export interface CreateApprovalInput {
  taskId: number;
  agentId: number | null;
  agentName: string;
  toolName: string;
  preview: string;
  args: Record<string, unknown> | null;
}

export interface AgentApprovalStore {
  create(input: CreateApprovalInput): AgentApproval;
  get(id: number): AgentApproval | undefined;
  listPending(): AgentApproval[];
  // Newest-first across all statuses, for the panel's history view.
  listRecent(limit: number): AgentApproval[];
  // Atomically decide a still-pending row. Returns the updated row, or undefined
  // if it was already decided (lost the race) — callers must treat undefined as
  // "someone else got there first".
  decide(id: number, approved: boolean, by: AgentApprovalDecider): AgentApproval | undefined;
  // Reject every pending row (daemon startup: parked promises from a previous
  // process are gone, so their rows would dangle forever). Returns the count.
  expireAllPending(by: AgentApprovalDecider): number;
}

interface ApprovalRow {
  id: number;
  task_id: number;
  agent_id: number | null;
  agent_name: string;
  tool_name: string;
  preview: string;
  args_json: string | null;
  status: string;
  decided_by: string | null;
  created_at: number;
  decided_at: number | null;
}

function rowToApproval(r: ApprovalRow): AgentApproval {
  let args: Record<string, unknown> | null = null;
  if (r.args_json) {
    try {
      const v = JSON.parse(r.args_json);
      if (v && typeof v === 'object') args = v as Record<string, unknown>;
    } catch {
      args = null;
    }
  }
  return {
    id: r.id,
    taskId: r.task_id,
    agentId: r.agent_id,
    agentName: r.agent_name,
    toolName: r.tool_name,
    preview: r.preview,
    args,
    status: r.status as AgentApprovalStatus,
    decidedBy: r.decided_by as AgentApprovalDecider | null,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
  };
}

export function createAgentApprovalStore(db: DB): AgentApprovalStore {
  const insert = db.prepare(
    `INSERT INTO agent_approvals
       (task_id, agent_id, agent_name, tool_name, preview, args_json, status, created_at)
     VALUES (@task_id, @agent_id, @agent_name, @tool_name, @preview, @args_json, 'pending', @created_at)`,
  );
  const selectById = db.prepare(`SELECT * FROM agent_approvals WHERE id = ?`);
  const selectPending = db.prepare(
    `SELECT * FROM agent_approvals WHERE status = 'pending' ORDER BY id`,
  );
  const decideStmt = db.prepare(
    `UPDATE agent_approvals SET status = @status, decided_by = @by, decided_at = @at
     WHERE id = @id AND status = 'pending'`,
  );

  function get(id: number): AgentApproval | undefined {
    const row = selectById.get(id) as ApprovalRow | undefined;
    return row ? rowToApproval(row) : undefined;
  }

  return {
    create(input) {
      const info = insert.run({
        task_id: input.taskId,
        agent_id: input.agentId,
        agent_name: input.agentName,
        tool_name: input.toolName,
        preview: input.preview,
        args_json: input.args ? JSON.stringify(input.args) : null,
        created_at: Date.now(),
      });
      return get(Number(info.lastInsertRowid))!;
    },
    get,
    listPending: () => (selectPending.all() as ApprovalRow[]).map(rowToApproval),
    listRecent: (limit) =>
      (
        db
          .prepare(`SELECT * FROM agent_approvals ORDER BY id DESC LIMIT ?`)
          .all(Math.max(1, Math.floor(limit))) as ApprovalRow[]
      ).map(rowToApproval),
    decide(id, approved, by) {
      const res = decideStmt.run({
        id,
        status: approved ? 'approved' : 'rejected',
        by,
        at: Date.now(),
      });
      return res.changes > 0 ? get(id) : undefined;
    },
    expireAllPending(by) {
      return db
        .prepare(
          `UPDATE agent_approvals SET status = 'rejected', decided_by = @by, decided_at = @at
           WHERE status = 'pending'`,
        )
        .run({ by, at: Date.now() }).changes;
    },
  };
}

// ---------------------------------------------------------------------------
// ApprovalManager — parks a tool call until a human decides.
// ---------------------------------------------------------------------------

export interface ApprovalRequestInput {
  taskId: number;
  toolName: string;
  preview: string;
  args: Record<string, unknown> | null;
  // Abort signal of the agent's orchestrator turn; firing it (task cancelled)
  // rejects the parked call so the run can unwind instead of hanging forever.
  signal?: AbortSignal;
}

export type ApprovalNotifier = (approval: AgentApproval) => void | Promise<void>;

export interface ApprovalManager {
  // Park a call. Resolves true (approved) / false (rejected/cancelled). Never
  // rejects and never times out — it waits for a human.
  request(input: ApprovalRequestInput): Promise<boolean>;
  // In-process decision (the Telegram Yes/No callback runs in the daemon).
  resolveFromTelegram(id: number, approved: boolean, byUserId: number): void;
  // Late-bind the notifier once the Telegram adapter exists.
  setNotifier(notify: ApprovalNotifier): void;
  shutdown(): void;
}

export interface ApprovalManagerOptions {
  store: AgentApprovalStore;
  registry: AgentRegistry;
  log: Logger;
  // How often to check the DB for a decision made by the other process (panel).
  pollMs?: number;
}

export function createApprovalManager(opts: ApprovalManagerOptions): ApprovalManager {
  const log = opts.log.child({ mod: 'agent-approvals' });
  const waiters = new Map<number, (approved: boolean) => void>();
  let notify: ApprovalNotifier | null = null;
  const pollMs = opts.pollMs ?? 1500;

  // Pending rows from a previous daemon process can never resolve (their parked
  // promises died with it), and their tasks are re-queued fresh on startup, so
  // clear them out rather than leave them dangling in the panel.
  const cleared = opts.store.expireAllPending('restart');
  if (cleared > 0) log.info('expired stale pending approvals on startup', { count: cleared });

  // The poll catches decisions the panel made by writing the row (in-process
  // Telegram decisions resolve immediately). It runs ONLY while something is
  // parked: a parked call is real work, so keeping the loop alive then is
  // correct, and there's no idle timer when nothing is waiting.
  let poll: ReturnType<typeof setInterval> | null = null;
  function tick(): void {
    for (const [id, resolve] of waiters) {
      const row = opts.store.get(id);
      if (!row || row.status !== 'pending') {
        resolve(row?.status === 'approved');
        continue;
      }
      // Defense in depth: if the owning task is no longer live (cancelled from
      // the panel cross-process, or already finished), release the parked call
      // as denied rather than wait for an answer to a step that won't run.
      const task = opts.registry.getTask(row.taskId);
      if (
        !task ||
        task.status === 'cancelled' ||
        task.status === 'error' ||
        task.status === 'done'
      ) {
        opts.store.decide(id, false, 'cancelled');
        resolve(false);
      }
    }
  }
  function startPolling(): void {
    if (!poll) poll = setInterval(tick, pollMs);
  }
  function stopPolling(): void {
    if (poll && waiters.size === 0) {
      clearInterval(poll);
      poll = null;
    }
  }

  async function fireNotify(approval: AgentApproval): Promise<void> {
    if (!notify) return;
    try {
      await notify(approval);
    } catch (e) {
      // A failed notification must NOT auto-approve or auto-reject — the row
      // stays pending and is still answerable from the panel.
      log.warn('approval notify failed', {
        id: approval.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return {
    async request(input) {
      const task = opts.registry.getTask(input.taskId);
      const agent = task ? opts.registry.get(task.agentId) : undefined;
      const approval = opts.store.create({
        taskId: input.taskId,
        agentId: agent?.id ?? null,
        agentName: agent?.name ?? '',
        toolName: input.toolName,
        preview: input.preview,
        args: input.args,
      });
      log.info('approval requested', {
        id: approval.id,
        task: input.taskId,
        agent: approval.agentName,
        tool: input.toolName,
      });
      void fireNotify(approval);

      return new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (approved: boolean): void => {
          if (settled) return;
          settled = true;
          waiters.delete(approval.id);
          input.signal?.removeEventListener('abort', onAbort);
          stopPolling();
          log.info('approval resolved', { id: approval.id, approved });
          resolve(approved);
        };
        const onAbort = (): void => {
          opts.store.decide(approval.id, false, 'cancelled');
          finish(false);
        };
        if (input.signal) {
          if (input.signal.aborted) return onAbort();
          input.signal.addEventListener('abort', onAbort, { once: true });
        }
        waiters.set(approval.id, finish);
        startPolling();
      });
    },

    resolveFromTelegram(id, approved, byUserId) {
      const updated = opts.store.decide(id, approved, 'telegram');
      // Lost the race (panel already decided) — leave the waiter to the poll,
      // which will resolve it from the row's real status.
      if (!updated) return;
      log.info('approval decided on telegram', { id, approved, byUserId });
      waiters.get(id)?.(approved);
    },

    setNotifier(fn) {
      notify = fn;
    },

    shutdown() {
      if (poll) {
        clearInterval(poll);
        poll = null;
      }
      // The daemon is going down; unblock any parked calls as denied so an
      // in-flight drain doesn't hang. Their tasks re-queue on next startup.
      for (const [, resolve] of waiters) resolve(false);
      waiters.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Setup — create the store + manager and register the request_approval tool.
// ---------------------------------------------------------------------------

export interface AgentApprovalsDeps {
  db: DB;
  tools: ToolRegistry;
  registry: AgentRegistry;
  log: Logger;
  pollMs?: number;
}

export function setupAgentApprovals(deps: AgentApprovalsDeps): {
  store: AgentApprovalStore;
  manager: ApprovalManager;
} {
  const store = createAgentApprovalStore(deps.db);
  const manager = createApprovalManager({
    store,
    registry: deps.registry,
    log: deps.log,
    ...(deps.pollMs !== undefined ? { pollMs: deps.pollMs } : {}),
  });

  // A 'confirm'-tier tool any agent can call to pause for human sign-off. The
  // confirm gate (start.ts -> ApprovalManager) runs BEFORE this handler, so
  // reaching invoke means it was approved; a rejection throws ToolDeniedError
  // and the agent sees the step was refused.
  deps.tools.register({
    name: REQUEST_APPROVAL_TOOL_NAME,
    description:
      'Pause and ask the human to approve a risky or irreversible step before you take it. ' +
      'Give a clear, specific reason; the user sees it and taps Yes or No on Telegram or the ' +
      'control panel. The step only proceeds if they approve.',
    tier: 'confirm',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description:
            'What you intend to do and why it needs sign-off. Shown to the user verbatim.',
        },
      },
      required: ['reason'],
    },
    confirmPrompt: (args) => {
      const reason = String(args['reason'] ?? '').trim();
      return reason || 'Approve this step?';
    },
    invoke: async () => 'Approved by the human — proceed with the step.',
  });

  return { store, manager };
}
