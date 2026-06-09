// WorkflowRunner — the daemon-side executor for authored workflows.
//
// Lives in the daemon process (the panel only writes DB rows). A poll timer
// claims the oldest queued workflow_runs row and walks the DAG deterministically
// in topological order: code decides which edges are live; the model runs only
// inside agent nodes. Each node execution writes a workflow_step_runs row so the
// UI can light up live, and agent nodes link the agent_tasks row they produce.
//
// Execution is sequential — one run, and within a run one node, at a time — so
// agent nodes (which use runtime.runTask inline, like spawn_agent's await mode)
// never contend for the single resident heavy-model slot.

import { join } from 'node:path';
import type { Logger } from '../util/log.js';
import type { AgentRegistry, AgentRuntime } from './agents.js';
import type { ToolRegistry } from './tools.js';
import type { LLM, ToolCall } from './llm.js';
import { ingestStagedDir, removeStagedBatch } from './agent-attachments.js';
import {
  topoOrder,
  type WorkflowNode,
  type WorkflowRegistry,
  type WorkflowRun,
} from './workflows.js';

export interface WorkflowRunnerDeps {
  registry: WorkflowRegistry;
  agents: AgentRegistry;
  runtime: AgentRuntime;
  tools: ToolRegistry;
  // Used only to unload the resident heavy model once a run drains. Optional so
  // tests can omit it; production (start.ts) always wires it.
  llm?: LLM;
  log: Logger;
  // User id stamped on agent-node conversation rows (same as AgentRuntime).
  ownerUserId: number;
  // Root for task input attachments (~/.modulus/agent-attachments). When set, a
  // run's staged upload batch is ingested into each agent-node task. Optional so
  // tests can omit it; production (start.ts) always wires it.
  attachmentsDir?: string;
  // Poll cadence for claiming queued runs. 0/unset disables the timer (tests
  // drive runOnce() directly).
  pollMs?: number;
  // Optional delivery hook for output nodes (e.g. send to Telegram). When unset
  // the output is only persisted on the run row.
  onOutput?: (channel: string, text: string, run: WorkflowRun) => void | Promise<void>;
}

export interface WorkflowRunner {
  start(): void;
  stop(): void;
  // Claim and execute one queued run. Returns true if a run was executed.
  runOnce(): Promise<boolean>;
  // Execute an already-claimed (running) run to completion. Exposed for tests.
  executeRun(runId: number): Promise<void>;
}

// Thrown by a node handler to fail the run with a human-readable reason.
class NodeError extends Error {}

interface RunScope {
  trigger: { input: string };
  steps: Record<string, Record<string, unknown>>;
  loop?: { item: unknown; index: number };
}

export function createWorkflowRunner(deps: WorkflowRunnerDeps): WorkflowRunner {
  const log = deps.log.child({ mod: 'workflow-runner' });
  let timer: ReturnType<typeof setInterval> | null = null;
  let draining = false;

  // -- template resolution (deterministic; no eval) -------------------------

  function resolvePath(scope: RunScope, path: string): unknown {
    const segs = path.split('.').map((s) => s.trim());
    // `item`/`index` are convenience aliases for the active loop binding.
    let cur: unknown =
      segs[0] === 'item'
        ? scope.loop?.item
        : segs[0] === 'index'
          ? scope.loop?.index
          : (scope as unknown as Record<string, unknown>)[segs[0]!];
    for (let i = 1; i < segs.length && cur != null; i++) {
      cur = (cur as Record<string, unknown>)[segs[i]!];
    }
    return cur;
  }

  function toText(v: unknown): string {
    if (v == null) return '';
    return typeof v === 'string' ? v : JSON.stringify(v);
  }

  function resolveTemplate(tpl: string, scope: RunScope): string {
    return tpl.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, path) =>
      toText(resolvePath(scope, String(path).trim())),
    );
  }

  // If the whole string is a single {{path}} token, return the raw value
  // (preserving number/array/object types for tool args); otherwise interpolate.
  function resolveMaybeWhole(s: string, scope: RunScope): unknown {
    const m = /^\{\{\s*([^}]+?)\s*\}\}$/.exec(s.trim());
    if (m) return resolvePath(scope, m[1]!.trim());
    return resolveTemplate(s, scope);
  }

  function resolveValue(v: unknown, scope: RunScope): unknown {
    if (typeof v === 'string') return resolveMaybeWhole(v, scope);
    if (Array.isArray(v)) return v.map((x) => resolveValue(x, scope));
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>))
        out[k] = resolveValue(val, scope);
      return out;
    }
    return v;
  }

  function asArray(v: unknown): unknown[] {
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') {
      const t = v.trim();
      if (t.startsWith('[')) {
        try {
          const parsed = JSON.parse(t);
          if (Array.isArray(parsed)) return parsed;
        } catch {
          /* fall through */
        }
      }
      return t
        ? t
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
        : [];
    }
    return v == null ? [] : [v];
  }

  // -- condition predicate --------------------------------------------------

  function evalCondition(node: WorkflowNode, scope: RunScope): boolean {
    const cfg = node.config;
    const op = String(cfg['op'] ?? 'not_empty');
    const left = toText(resolveValue(cfg['left'], scope));
    const right = toText(resolveValue(cfg['right'], scope));
    switch (op) {
      case 'contains':
        return left.toLowerCase().includes(right.toLowerCase());
      case 'equals':
        return left === right;
      case 'not_equals':
        return left !== right;
      case 'gt':
        return Number(left) > Number(right);
      case 'lt':
        return Number(left) < Number(right);
      case 'regex':
        try {
          return new RegExp(right).test(left);
        } catch {
          return false;
        }
      case 'empty':
        return left.trim() === '';
      case 'not_empty':
      default:
        return left.trim() !== '';
    }
  }

  // -- per-node execution ---------------------------------------------------
  // Returns the node's output context (merged into scope.steps[id]) plus, for a
  // condition node, the branch taken. Throws NodeError to fail the run.

  async function runNode(
    node: WorkflowNode,
    scope: RunScope,
    runId: number,
  ): Promise<{ ctx: Record<string, unknown>; branch?: string }> {
    switch (node.type) {
      case 'trigger':
        return { ctx: { output: scope.trigger.input } };

      case 'transform': {
        const tpl = String(node.config['template'] ?? '');
        const as = String(node.config['as'] ?? 'output') || 'output';
        const text = resolveTemplate(tpl, scope);
        return { ctx: { output: text, [as]: text } };
      }

      case 'condition': {
        const pass = evalCondition(node, scope);
        return { ctx: { output: String(pass) }, branch: pass ? 'true' : 'false' };
      }

      case 'agent': {
        const agentId = Number(node.config['agentId']);
        const agent = deps.agents.get(agentId);
        if (!agent)
          throw new NodeError(`agent node '${node.id}' references unknown agent #${agentId}`);
        const prompt = resolveTemplate(
          String(node.config['promptTemplate'] ?? '{{trigger.input}}'),
          scope,
        );
        // Per-node thinking override: a workflow can make one agent reason and
        // another not, regardless of each agent's saved default. Anything other
        // than auto|on|off (incl. unset/"inherit") leaves the agent default.
        const nodeThink = node.config['thinkMode'];
        const thinkMode =
          nodeThink === 'auto' || nodeThink === 'on' || nodeThink === 'off' ? nodeThink : undefined;
        const task = deps.agents.enqueue({ agentId, prompt, ...(thinkMode ? { thinkMode } : {}) });
        // Ingest the run's uploaded batch into this node's task before it runs,
        // so the agent's model sees images and read_file/list_dir pin to the
        // files. keepStaging leaves the batch for sibling agent nodes; runOnce
        // removes it once the run drains. Images are gated on the node agent's
        // own multimodal capability.
        const run = deps.registry.getRun(runId);
        if (run?.stageToken && deps.attachmentsDir) {
          const model = deps.llm?.resolveModel(agent.profile);
          const allowVisual =
            model && deps.llm?.supportsVision ? await deps.llm.supportsVision(model) : false;
          await ingestStagedDir({
            registry: deps.agents,
            baseDir: deps.attachmentsDir,
            taskId: task.id,
            stagingDir: join(deps.attachmentsDir, 'staging', run.stageToken),
            allowVisual,
            keepStaging: true,
          });
        }
        // The agent_tasks id is returned in ctx; executeRun writes it onto the
        // step row so mission-control can surface the transcript.
        const result = await deps.runtime.runTask(task.id);
        if (!result.ok) {
          throw new NodeError(`agent '${agent.name}' failed: ${result.error ?? 'unknown error'}`);
        }
        return { ctx: { output: result.text, agentTaskId: task.id } };
      }

      case 'tool': {
        const name = String(node.config['tool'] ?? '').trim();
        if (!name) throw new NodeError(`tool node '${node.id}' has no tool selected`);
        const args =
          (resolveValue(node.config['args'] ?? {}, scope) as Record<string, unknown>) ?? {};
        const call: ToolCall = { id: `wf_${runId}_${node.id}`, name, arguments: args };
        const result = await deps.tools.execute(call, { log: log.child({ node: node.id }) });
        if (!result.ok) throw new NodeError(`tool '${name}' failed: ${result.output}`);
        return { ctx: { output: result.output } };
      }

      case 'loop': {
        const items = asArray(resolveValue(node.config['items'], scope));
        const body = node.config['body'] as
          | { type?: string; config?: Record<string, unknown> }
          | undefined;
        if (!body || !body.type) throw new NodeError(`loop node '${node.id}' has no body`);
        const outputs: unknown[] = [];
        for (let i = 0; i < items.length; i++) {
          // Bind {{item}}/{{index}} for the body's templates, then run the body
          // as a one-off inline node sharing the same scope.
          scope.loop = { item: items[i], index: i };
          const bodyNode: WorkflowNode = {
            id: `${node.id}#${i}`,
            type: body.type as WorkflowNode['type'],
            pos: { x: 0, y: 0 },
            config: body.config ?? {},
          };
          const r = await runNode(bodyNode, scope, runId);
          outputs.push(r.ctx['output']);
        }
        scope.loop = undefined;
        return { ctx: { output: JSON.stringify(outputs), items: outputs } };
      }

      case 'output': {
        const channel = String(node.config['channel'] ?? 'none');
        const tpl = String(node.config['template'] ?? '{{trigger.input}}');
        const text = resolveTemplate(tpl, scope);
        if (channel !== 'none' && deps.onOutput) {
          const run = deps.registry.getRun(runId);
          if (run) await deps.onOutput(channel, text, run);
        }
        return { ctx: { output: text } };
      }

      default:
        throw new NodeError(`unsupported node type '${(node as WorkflowNode).type}'`);
    }
  }

  // -- DAG walk -------------------------------------------------------------

  async function executeRun(runId: number): Promise<void> {
    const run = deps.registry.getRun(runId);
    if (!run) return;
    const wf = deps.registry.get(run.workflowId);
    if (!wf) {
      deps.registry.updateRun(runId, {
        status: 'error',
        error: 'workflow not found',
        finishedAt: Date.now(),
      });
      return;
    }
    const graph = wf.graph;
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const scope: RunScope = { trigger: { input: run.input ?? '' }, steps: {} };

    // Edge liveness: a node runs iff it's an entry (no incoming) or has a live
    // incoming edge. After a node runs, its outgoing edges go live — except a
    // condition node, which only lights the branch that matched.
    const liveEdge = new Set<number>();
    const edgeIndex = (from: string, to: string, branch: string | undefined): number =>
      graph.edges.findIndex((e) => e.from === from && e.to === to && e.branch === branch);

    let lastOutput = '';
    const outputTexts: string[] = [];

    for (const nodeId of topoOrder(graph)) {
      // Cooperative cancellation between nodes.
      if (deps.registry.getRun(runId)?.status === 'cancelled') {
        log.info('workflow run cancelled', { runId });
        return;
      }
      const node = byId.get(nodeId);
      if (!node) continue;
      // Loop body nodes (id like "x#0") never appear here — they live only
      // inside the loop handler. Skip orphan/embedded ids defensively.
      const incoming = graph.edges.map((e, i) => ({ e, i })).filter(({ e }) => e.to === nodeId);
      const isEntry = node.type === 'trigger' || incoming.length === 0;
      const hasLive = incoming.some(({ i }) => liveEdge.has(i));
      if (!isEntry && !hasLive) continue; // pruned branch — no row, per design

      const step = deps.registry.addStepRun({ runId, nodeId, nodeType: node.type });
      try {
        const { ctx, branch } = await runNode(node, scope, runId);
        scope.steps[nodeId] = ctx;
        deps.registry.updateStepRun(step.id, {
          status: 'done',
          output: toText(ctx['output']),
          ...(typeof ctx['agentTaskId'] === 'number' ? { agentTaskId: ctx['agentTaskId'] } : {}),
          finishedAt: Date.now(),
        });
        lastOutput = toText(ctx['output']);
        if (node.type === 'output') outputTexts.push(lastOutput);

        // Light outgoing edges.
        for (const e of graph.edges) {
          if (e.from !== nodeId) continue;
          if (node.type === 'condition' && e.branch !== branch) continue;
          const idx = edgeIndex(e.from, e.to, e.branch);
          if (idx >= 0) liveEdge.add(idx);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        deps.registry.updateStepRun(step.id, {
          status: 'error',
          error: msg,
          finishedAt: Date.now(),
        });
        deps.registry.updateRun(runId, { status: 'error', error: msg, finishedAt: Date.now() });
        log.warn('workflow run failed', { runId, node: nodeId, error: msg });
        return;
      }
    }

    if (deps.registry.getRun(runId)?.status === 'cancelled') return;
    const output = outputTexts.length ? outputTexts.join('\n\n') : lastOutput;
    deps.registry.updateRun(runId, { status: 'done', output, finishedAt: Date.now() });
    log.info('workflow run done', { runId, workflow: wf.name });
  }

  async function runOnce(): Promise<boolean> {
    const run = deps.registry.claimNextQueuedRun();
    if (!run) return false;
    await executeRun(run.id);
    // The run is over (done/error/cancelled) — every agent node that was going
    // to read the uploaded batch has. Remove it once, regardless of outcome.
    if (run.stageToken && deps.attachmentsDir) {
      try {
        removeStagedBatch(deps.attachmentsDir, run.stageToken);
      } catch {
        /* best effort — a leftover staging dir must not break the runner */
      }
    }
    // The run finished (done/error/cancelled). If nothing else is queued, the
    // workflow side has drained — unload the resident heavy model the run's
    // agent nodes may have loaded, rather than letting it pin RAM through the
    // keep_alive / idle-sweep window. Checked here (not after every node, and
    // only when the queue empties) so a burst of queued runs reuses the model
    // instead of paying a cold reload between each.
    if (deps.registry.listRuns({ status: 'queued' }).length === 0) {
      try {
        await deps.llm?.releaseHeavy?.();
      } catch {
        /* best effort — a failed unload must not break the runner */
      }
    }
    return true;
  }

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      // Keep claiming until the queue is empty so a burst doesn't wait a whole
      // poll interval per run.
      while (await runOnce()) {
        /* loop */
      }
    } catch (e) {
      log.warn('workflow drain error', { error: e instanceof Error ? e.message : String(e) });
    } finally {
      draining = false;
    }
  }

  function start(): void {
    if (timer || !deps.pollMs || deps.pollMs <= 0) return;
    timer = setInterval(() => void drain(), deps.pollMs);
    timer.unref?.();
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { start, stop, runOnce, executeRun };
}
