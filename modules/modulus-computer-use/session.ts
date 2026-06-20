// The perception->action loop and the manager that owns the single live
// session. Each iteration: check the foreground app against the allowlist,
// capture, ask the vision backend for the next action, gate sensitive actions,
// execute, record. The loop ends on done/ask, Stop (AbortSignal OR the
// stop_requested DB flag the panel can flip), an error, or the step cap.
//
// One session at a time — the screen and the heavy vision model are both
// singletons, so two concurrent operators would fight over them.

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { DB } from '../../src/storage/db.js';
import type { Logger } from '../../src/util/log.js';
import type { ControlBackend } from './win-control.js';
import type { Vision, VisionConfig, VisionDecision } from './vision.js';

export interface SessionConfig {
  vision: VisionConfig;
  // Lowercased process names the operator may act in; '*' allows any; empty
  // means nothing is allowed (safe default).
  appAllowlist: string[];
  maxSteps: number;
  stepDelayMs: number;
}

export interface SessionEvent {
  type: 'step' | 'status';
  sessionId: number;
  stepNo?: number;
  action?: string;
  outcome?: string;
  detail?: string;
  rationale?: string;
  foreground?: string;
  screenshot?: string;
  status?: string;
}

export interface SessionDeps {
  db: DB;
  backend: ControlBackend;
  vision: Vision;
  log: Logger;
  // Module data dir; screenshots are written under <dataDir>/sessions/<id>/.
  dataDir: string;
  // Per-step surface sink (Telegram post, panel SSE). Best-effort.
  emit?: (ev: SessionEvent) => void | Promise<void>;
  // Approval gate for sensitive actions. Absent / false => fail closed (the
  // session pauses rather than performing it). Wired by tools.ts.
  confirm?: (preview: string) => Promise<boolean>;
  // Injectable for tests so the inter-step delay doesn't slow the suite.
  sleep?: (ms: number) => Promise<void>;
}

export interface StartInput {
  goal: string;
  chatId?: number;
}

// Keywords that flag a genuinely consequential action. Heuristic by design —
// the app allowlist is the real fence; this is the extra pause before money
// moves or data is destroyed. Matched against the action's rationale and any
// typed text / key combo.
const SENSITIVE = /\b(send|buy|purchase|pay|payment|checkout|order|transfer|delete|remove|uninstall|format|wipe|shutdown|sign\s?out|log\s?out)\b/i;

function isSensitive(d: VisionDecision): boolean {
  const parts = [d.rationale];
  if (d.action === 'type') parts.push(String(d.args['text'] ?? ''));
  if (d.action === 'key') parts.push(String(d.args['combo'] ?? ''));
  return SENSITIVE.test(parts.join(' '));
}

function appAllowed(proc: string, allowlist: readonly string[]): boolean {
  if (allowlist.length === 0) return false;
  if (allowlist.includes('*')) return true;
  return allowlist.includes(proc.toLowerCase());
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function createSessionManager(deps: SessionDeps, getConfig: () => SessionConfig) {
  const active = new Map<number, AbortController>();
  const sleep = deps.sleep ?? defaultSleep;
  const now = (): number => Date.now();

  const insertSession = deps.db.prepare(
    `INSERT INTO computer_use_sessions (goal, chat_id, status, started_at) VALUES (?, ?, 'running', ?)`,
  );
  const insertStep = deps.db.prepare(
    `INSERT INTO computer_use_steps
       (session_id, step_no, action, args_json, rationale, foreground, screenshot, outcome, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const finishSession = deps.db.prepare(
    `UPDATE computer_use_sessions SET status = ?, summary = ?, finished_at = ? WHERE id = ?`,
  );
  const readStop = deps.db.prepare(
    `SELECT stop_requested FROM computer_use_sessions WHERE id = ?`,
  );

  async function emit(ev: SessionEvent): Promise<void> {
    if (!deps.emit) return;
    try {
      await deps.emit(ev);
    } catch (e) {
      deps.log.warn('computer-use emit failed', { error: e instanceof Error ? e.message : String(e) });
    }
  }

  function recordStep(
    sessionId: number,
    stepNo: number,
    d: Pick<VisionDecision, 'action' | 'args' | 'rationale'>,
    outcome: string,
    detail: string,
    foreground: string,
    screenshot: string | null,
  ): SessionEvent {
    insertStep.run(
      sessionId,
      stepNo,
      d.action,
      JSON.stringify(d.args ?? {}),
      d.rationale || null,
      foreground || null,
      screenshot,
      outcome,
      detail || null,
      now(),
    );
    return {
      type: 'step',
      sessionId,
      stepNo,
      action: d.action,
      outcome,
      detail,
      rationale: d.rationale,
      foreground,
      ...(screenshot ? { screenshot } : {}),
    };
  }

  function stopRequested(sessionId: number): boolean {
    const row = readStop.get(sessionId) as { stop_requested?: number } | undefined;
    return !!row && row.stop_requested === 1;
  }

  async function finalize(sessionId: number, status: string, summary: string): Promise<void> {
    finishSession.run(status, summary || null, now(), sessionId);
    active.delete(sessionId);
    await emit({ type: 'status', sessionId, status, detail: summary });
  }

  async function execute(d: VisionDecision): Promise<void> {
    const a = d.args;
    const num = (k: string): number => Number(a[k] ?? 0);
    switch (d.action) {
      case 'click':
        return deps.backend.click(num('x'), num('y'), 'left');
      case 'double_click':
        return deps.backend.click(num('x'), num('y'), 'double');
      case 'right_click':
        return deps.backend.click(num('x'), num('y'), 'right');
      case 'type':
        return deps.backend.type(String(a['text'] ?? ''));
      case 'key':
        return deps.backend.key(String(a['combo'] ?? ''));
      case 'scroll':
        return deps.backend.scroll(0, num('dy'));
      case 'drag':
        return deps.backend.drag(num('fromX'), num('fromY'), num('toX'), num('toY'));
      case 'wait':
        return sleep(Math.min(5000, Math.max(0, num('ms') || 500)));
      default:
        throw new Error(`unexecutable action: ${d.action}`);
    }
  }

  async function runLoop(
    sessionId: number,
    goal: string,
    signal: AbortSignal,
  ): Promise<void> {
    const cfg = getConfig();
    const sessionDir = join(deps.dataDir, 'sessions', String(sessionId));
    await mkdir(sessionDir, { recursive: true }).catch(() => {});
    const history: string[] = [];

    for (let step = 1; step <= cfg.maxSteps; step++) {
      if (signal.aborted) return finalize(sessionId, 'stopped', 'Stopped by user.');
      if (stopRequested(sessionId)) return finalize(sessionId, 'stopped', 'Stopped from the panel.');

      // Foreground gate first — never even screenshot a disallowed app.
      const fg = await deps.backend.foreground().catch(() => ({ process: '', title: '' }));
      const fgStr = `${fg.process} | ${fg.title}`.trim();
      if (!appAllowed(fg.process, cfg.appAllowlist)) {
        const ev = recordStep(
          sessionId,
          step,
          { action: 'wait', args: {}, rationale: '' },
          'blocked',
          `Foreground app '${fg.process || 'unknown'}' is not in the allowlist — waiting.`,
          fgStr,
          null,
        );
        await emit(ev);
        await sleep(Math.max(cfg.stepDelayMs, 800));
        continue;
      }

      let shot;
      try {
        shot = await deps.backend.capture(join(sessionDir, `step-${step}.png`));
      } catch (e) {
        await emit(
          recordStep(
            sessionId,
            step,
            { action: 'wait', args: {}, rationale: '' },
            'error',
            `Screenshot failed: ${e instanceof Error ? e.message : String(e)}`,
            fgStr,
            null,
          ),
        );
        return finalize(sessionId, 'error', 'Could not capture the screen.');
      }

      let decision: VisionDecision;
      try {
        decision = await deps.vision.decide(cfg.vision, {
          goal,
          screenshotB64: shot.base64,
          width: shot.width,
          height: shot.height,
          history,
          signal,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await emit(
          recordStep(
            sessionId,
            step,
            { action: 'wait', args: {}, rationale: '' },
            'error',
            `Vision model failed: ${msg}`,
            fgStr,
            shot.path,
          ),
        );
        return finalize(sessionId, 'error', `Vision model failed: ${msg}`);
      }

      // Terminal actions.
      if (decision.action === 'done') {
        await emit(recordStep(sessionId, step, decision, 'ok', '', fgStr, shot.path));
        return finalize(sessionId, 'done', String(decision.args['summary'] ?? decision.rationale ?? 'Done.'));
      }
      if (decision.action === 'ask') {
        const q = String(decision.args['question'] ?? decision.rationale ?? 'Need input.');
        await emit(recordStep(sessionId, step, decision, 'ok', q, fgStr, shot.path));
        return finalize(sessionId, 'paused', `Needs you: ${q}`);
      }

      // Sensitive-action gate — fail closed when no approver is wired.
      if (isSensitive(decision)) {
        const preview = `"${goal}" wants to ${decision.action}: ${decision.rationale || JSON.stringify(decision.args)}`;
        const ok = deps.confirm ? await deps.confirm(preview).catch(() => false) : false;
        if (!ok) {
          await emit(recordStep(sessionId, step, decision, 'blocked', 'Sensitive action not approved.', fgStr, shot.path));
          return finalize(sessionId, 'paused', `Stopped before a sensitive action (${decision.action}). Do this step yourself, then re-run.`);
        }
      }

      // Re-check the foreground after vision latency: focus may have moved.
      const fg2 = await deps.backend.foreground().catch(() => fg);
      if (!appAllowed(fg2.process, cfg.appAllowlist)) {
        await emit(
          recordStep(sessionId, step, decision, 'blocked', `Foreground changed to '${fg2.process}' — skipped.`, `${fg2.process} | ${fg2.title}`.trim(), shot.path),
        );
        await sleep(cfg.stepDelayMs);
        continue;
      }

      try {
        await execute(decision);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await emit(recordStep(sessionId, step, decision, 'error', msg, fgStr, shot.path));
        history.push(`#${step} ${decision.action} FAILED: ${msg}`);
        await sleep(cfg.stepDelayMs);
        continue;
      }

      const summary = `#${step} ${decision.action}(${JSON.stringify(decision.args)})${decision.rationale ? ` — ${decision.rationale}` : ''}`;
      history.push(summary.slice(0, 200));
      await emit(recordStep(sessionId, step, decision, 'ok', '', fgStr, shot.path));
      await sleep(cfg.stepDelayMs);
    }

    return finalize(sessionId, 'done', `Reached the ${cfg.maxSteps}-step limit.`);
  }

  return {
    // Start a session. Returns immediately with the id and a promise that
    // resolves when the (detached) loop finishes, so callers can either await
    // it (tests) or fire-and-forget (the tool, which reports progress via emit).
    start(input: StartInput): { sessionId: number; done: Promise<void> } {
      if (active.size > 0) {
        throw new Error('A computer-use session is already running. Stop it first.');
      }
      const info = insertSession.run(input.goal, input.chatId ?? null, now());
      const sessionId = Number(info.lastInsertRowid);
      const ac = new AbortController();
      active.set(sessionId, ac);
      void emit({ type: 'status', sessionId, status: 'running', detail: input.goal });
      const done = runLoop(sessionId, input.goal, ac.signal).catch(async (e) => {
        deps.log.error('computer-use loop crashed', {
          sessionId,
          error: e instanceof Error ? e.message : String(e),
        });
        await finalize(sessionId, 'error', e instanceof Error ? e.message : String(e));
      });
      return { sessionId, done };
    },
    stop(sessionId?: number): boolean {
      const id = sessionId ?? [...active.keys()][0];
      if (id === undefined) return false;
      const ac = active.get(id);
      if (!ac) return false;
      ac.abort();
      try {
        deps.db.prepare(`UPDATE computer_use_sessions SET stop_requested = 1 WHERE id = ?`).run(id);
      } catch {
        /* row may be gone; the abort already halts the loop */
      }
      return true;
    },
    activeIds(): number[] {
      return [...active.keys()];
    },
    isActive(): boolean {
      return active.size > 0;
    },
  };
}

export type SessionManager = ReturnType<typeof createSessionManager>;
