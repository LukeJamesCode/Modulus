// Approval-gated self-improving skills (v2.0.0).
//
// An agent or the user PROPOSES a skill (new or an edit). The proposal is pure
// data — a synthesized skill.json + a SKILL.md body — parked in skill_proposals,
// off the live skills dir. Only when the owner approves is it written through the
// installer's code-free gate and hot-loaded; rejection never touches disk.
//
// The security thesis (carried from 1.5.0): a skill is data, never code. The
// model can rewrite GUIDANCE but can never add executable content (assertNoExecutableContent
// runs at commit, and the loader runs it again at load) and can never grant itself
// a tool — a skill's reach stays tools ∩ installed+permitted, enforced by the
// activation layer, regardless of what the playbook says. Only the owner approves;
// an agent cannot self-approve and a chat user cannot approve.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '../storage/db.js';
import type { Logger } from '../util/log.js';
import type { ToolRegistry, ToolContext } from './tools.js';
import type { SkillLoader } from './skills.js';
import {
  assertNoExecutableContent,
  commitSkill,
  MAX_SKILL_INSTRUCTIONS_BYTES,
  MAX_INTENT_PATTERN_LEN,
  type StagedSkill,
} from './installer.js';
import { isAgentChatId, AGENT_CHAT_ID_BASE, type AgentRegistry } from './agents.js';

export const PROPOSE_SKILL_TOOL_NAME = 'propose_skill';

// Matches the loader's SKILL_NAME_RE and the installer's MODULE_NAME_RE (which
// commitSkill re-checks as the real enforcement).
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;
// Hard cap on outstanding pending proposals, so a misbehaving agent can't flood
// the owner's review queue.
const MAX_PENDING_PROPOSALS = 50;

export type SkillProposalStatus = 'pending' | 'approved' | 'rejected' | 'superseded';

export interface SkillProposal {
  id: number;
  skillName: string;
  baseVersion: string | null;
  manifest: Record<string, unknown>;
  instructions: string;
  rationale: string;
  proposedBy: string;
  status: SkillProposalStatus;
  createdAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
}

export interface CreateProposalInput {
  skillName: string;
  baseVersion: string | null;
  manifest: Record<string, unknown>;
  instructions: string;
  rationale: string;
  proposedBy: string;
}

export interface SkillProposalStore {
  create(input: CreateProposalInput): SkillProposal;
  get(id: number): SkillProposal | undefined;
  listPending(): SkillProposal[];
  listRecent(limit: number): SkillProposal[];
  countPending(): number;
  // Atomically decide a still-pending row. Returns the updated row, or undefined
  // when it was already decided (lost the race / not found).
  decide(id: number, approved: boolean, by: string): SkillProposal | undefined;
  // A fresh proposal for the same skill supersedes older pending ones. Returns
  // the count superseded.
  supersedePendingFor(skillName: string): number;
  expireAllPending(by: string): number;
}

interface ProposalRow {
  id: number;
  skill_name: string;
  base_version: string | null;
  manifest_json: string;
  instructions: string;
  rationale: string;
  proposed_by: string;
  status: string;
  created_at: number;
  decided_at: number | null;
  decided_by: string | null;
}

function rowToProposal(r: ProposalRow): SkillProposal {
  let manifest: Record<string, unknown> = {};
  try {
    const v = JSON.parse(r.manifest_json);
    if (v && typeof v === 'object') manifest = v as Record<string, unknown>;
  } catch {
    manifest = {};
  }
  return {
    id: r.id,
    skillName: r.skill_name,
    baseVersion: r.base_version,
    manifest,
    instructions: r.instructions,
    rationale: r.rationale,
    proposedBy: r.proposed_by,
    status: r.status as SkillProposalStatus,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
    decidedBy: r.decided_by,
  };
}

export function createSkillProposalStore(db: DB): SkillProposalStore {
  const insert = db.prepare(
    `INSERT INTO skill_proposals
       (skill_name, base_version, manifest_json, instructions, rationale, proposed_by, status, created_at)
     VALUES (@skill_name, @base_version, @manifest_json, @instructions, @rationale, @proposed_by, 'pending', @created_at)`,
  );
  const selectById = db.prepare(`SELECT * FROM skill_proposals WHERE id = ?`);
  const selectPending = db.prepare(
    `SELECT * FROM skill_proposals WHERE status = 'pending' ORDER BY created_at, id`,
  );
  const decideStmt = db.prepare(
    `UPDATE skill_proposals SET status = @status, decided_by = @by, decided_at = @at
     WHERE id = @id AND status = 'pending'`,
  );

  function get(id: number): SkillProposal | undefined {
    const row = selectById.get(id) as ProposalRow | undefined;
    return row ? rowToProposal(row) : undefined;
  }

  return {
    create(input) {
      const info = insert.run({
        skill_name: input.skillName,
        base_version: input.baseVersion,
        manifest_json: JSON.stringify(input.manifest),
        instructions: input.instructions,
        rationale: input.rationale,
        proposed_by: input.proposedBy,
        created_at: Date.now(),
      });
      return get(Number(info.lastInsertRowid))!;
    },
    get,
    listPending: () => (selectPending.all() as ProposalRow[]).map(rowToProposal),
    listRecent: (limit) =>
      (
        db
          .prepare(`SELECT * FROM skill_proposals ORDER BY id DESC LIMIT ?`)
          .all(Math.max(1, Math.floor(limit))) as ProposalRow[]
      ).map(rowToProposal),
    countPending: () =>
      (
        db.prepare(`SELECT COUNT(*) AS n FROM skill_proposals WHERE status = 'pending'`).get() as {
          n: number;
        }
      ).n,
    decide(id, approved, by) {
      const res = decideStmt.run({
        id,
        status: approved ? 'approved' : 'rejected',
        by,
        at: Date.now(),
      });
      return res.changes > 0 ? get(id) : undefined;
    },
    supersedePendingFor(skillName) {
      return db
        .prepare(
          `UPDATE skill_proposals SET status = 'superseded', decided_at = @at
           WHERE skill_name = @name AND status = 'pending'`,
        )
        .run({ name: skillName, at: Date.now() }).changes;
    },
    expireAllPending(by) {
      return db
        .prepare(
          `UPDATE skill_proposals SET status = 'rejected', decided_by = @by, decided_at = @at
           WHERE status = 'pending'`,
        )
        .run({ by, at: Date.now() }).changes;
    },
  };
}

// ---------------------------------------------------------------------------
// ProposalManager — register propose_skill, and commit/hot-load on approval.
// ---------------------------------------------------------------------------

export type ProposalNotifier = (proposal: SkillProposal) => void | Promise<void>;

export interface CommitResult {
  ok: boolean;
  name?: string;
  error?: string;
}

export interface SkillImproveDeps {
  db: DB;
  tools: ToolRegistry;
  // The live skill loader: existence checks at propose time, hot-reload at commit.
  skills: Pick<SkillLoader, 'get' | 'reload'>;
  log: Logger;
  hostVersion: string;
  // Where committed skills live (~/.modulus/skills) + a temp staging root.
  skillsRoot: string;
  stagingRoot: string;
  // Resolves an agent name when a proposal comes from an agent run. Optional.
  registry?: Pick<AgentRegistry, 'get' | 'getTask'>;
}

export interface ProposalManager {
  approve(id: number, by: string): Promise<CommitResult>;
  reject(id: number, by: string): CommitResult;
  setNotifier(fn: ProposalNotifier): void;
}

export interface SkillImproveHandle {
  store: SkillProposalStore;
  manager: ProposalManager;
}

function hostRange(hostVersion: string): string {
  const m = /^(\d+)\.(\d+)/.exec(hostVersion);
  return m ? `>=${m[1]}.${m[2]}.0` : '>=0.1.0';
}

function nextVersion(base: string | null): string {
  if (!base) return '1.0.0';
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(base);
  return m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}` : '1.0.0';
}

function errStr(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function setupSkillImprove(deps: SkillImproveDeps): SkillImproveHandle {
  const log = deps.log.child({ mod: 'skill-improve' });
  const store = createSkillProposalStore(deps.db);
  let notify: ProposalNotifier | null = null;

  function resolveProposer(ctx: ToolContext): string {
    const chatId = ctx.chatId;
    if (chatId !== undefined && isAgentChatId(chatId) && deps.registry) {
      const task = deps.registry.getTask(chatId - AGENT_CHAT_ID_BASE);
      const agent = task ? deps.registry.get(task.agentId) : undefined;
      if (agent) return `agent:${agent.name}`;
    }
    return 'assistant';
  }

  async function fireNotify(p: SkillProposal): Promise<void> {
    if (!notify) return;
    try {
      await notify(p);
    } catch (e) {
      log.warn('skill proposal notify failed', { id: p.id, error: errStr(e) });
    }
  }

  // Write the proposed bundle to a temp dir, run the code-free gate, and copy it
  // into the live skills root. Synchronous file work; the caller hot-reloads.
  function commitProposal(p: SkillProposal): CommitResult {
    const toolsList = Array.isArray(p.manifest['tools'])
      ? (p.manifest['tools'] as unknown[]).filter((t): t is string => typeof t === 'string')
      : [];
    mkdirSync(deps.stagingRoot, { recursive: true });
    const dir = mkdtempSync(join(deps.stagingRoot, `${p.skillName}-`));
    try {
      writeFileSync(join(dir, 'skill.json'), JSON.stringify(p.manifest, null, 2));
      writeFileSync(join(dir, 'SKILL.md'), p.instructions);
      // Commit-time code-free gate (the loader runs it again at load).
      assertNoExecutableContent(dir);
      const staged: StagedSkill = {
        name: p.skillName,
        version: String(p.manifest['version'] ?? '1.0.0'),
        dir,
        manifest: p.manifest,
        tools: toolsList,
      };
      const have = existsSync(join(deps.skillsRoot, p.skillName));
      commitSkill(staged, deps.skillsRoot, { replace: have });
      return { ok: true, name: p.skillName };
    } catch (e) {
      rmSync(dir, { recursive: true, force: true });
      return { ok: false, error: errStr(e) };
    }
  }

  const manager: ProposalManager = {
    async approve(id, by) {
      // Claim it atomically first so a second approval can't double-commit.
      const decided = store.decide(id, true, by);
      if (!decided) return { ok: false, error: 'proposal already decided or not found' };
      const committed = commitProposal(decided);
      if (!committed.ok) {
        log.warn('skill proposal commit failed', { id, error: committed.error });
        return committed;
      }
      try {
        await deps.skills.reload(committed.name!);
      } catch (e) {
        log.warn('skill reload after approval failed', { name: committed.name, error: errStr(e) });
      }
      log.info('skill proposal approved + committed', { id, name: committed.name, by });
      return committed;
    },
    reject(id, by) {
      const decided = store.decide(id, false, by);
      if (!decided) return { ok: false, error: 'proposal already decided or not found' };
      log.info('skill proposal rejected', { id, by });
      return { ok: true, name: decided.skillName };
    },
    setNotifier(fn) {
      notify = fn;
    },
  };

  deps.tools.register({
    name: PROPOSE_SKILL_TOOL_NAME,
    description:
      'Propose a new skill (a reusable, step-by-step playbook for a recurring task) or an ' +
      'improvement to an existing one, for the owner to approve. A skill is reference guidance ' +
      'plus a list of tools you ALREADY have — never code. Proposing does not change anything; the ' +
      'owner reviews and approves before it goes live. Use it when you notice a task you could do ' +
      'better next time with a written playbook.',
    tier: 'auto',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Skill id: lowercase letters, digits, - or _ (e.g. "expense-report").',
        },
        summary: { type: 'string', description: 'One line describing what the skill does.' },
        instructions: {
          type: 'string',
          description: 'The SKILL.md playbook body — the step-by-step guidance to follow.',
        },
        tools: {
          type: 'array',
          items: { type: 'string' },
          description: 'Names of EXISTING tools the playbook uses. The skill grants no new tools.',
        },
        rationale: {
          type: 'string',
          description: 'Why this skill/change helps. Shown to the owner verbatim.',
        },
        intent_pattern: {
          type: 'string',
          description: 'Optional case-insensitive regex of when this skill is relevant.',
        },
        mode: {
          type: 'string',
          enum: ['new', 'edit'],
          description: "'new' for a brand-new skill, 'edit' to revise an existing one.",
        },
      },
      required: ['name', 'summary', 'instructions', 'rationale'],
    },
    invoke: async (args, ctx) => {
      const name = String(args['name'] ?? '').trim();
      if (!SKILL_NAME_RE.test(name)) {
        return `Invalid skill name '${name}'. Use 2–64 chars: lowercase letters, digits, - or _.`;
      }
      const summary = String(args['summary'] ?? '').trim();
      if (!summary) return 'A one-line `summary` is required.';
      const instructions = String(args['instructions'] ?? '');
      if (!instructions.trim())
        return 'The `instructions` (the SKILL.md playbook body) are required.';
      if (Buffer.byteLength(instructions, 'utf8') > MAX_SKILL_INSTRUCTIONS_BYTES) {
        return `The playbook exceeds the ${MAX_SKILL_INSTRUCTIONS_BYTES}-byte cap; shorten it.`;
      }
      const rationale = String(args['rationale'] ?? '').trim();
      if (!rationale)
        return 'A short `rationale` (why this helps) is required — the owner sees it.';

      const toolsList = Array.isArray(args['tools'])
        ? args['tools'].filter((t): t is string => typeof t === 'string')
        : [];
      for (const t of toolsList) {
        if (!deps.tools.get(t)) {
          log.info('proposed skill references a tool not currently installed', { tool: t });
        }
      }

      let intentPattern: string | undefined;
      const ip = args['intent_pattern'];
      if (typeof ip === 'string' && ip.trim()) {
        if (ip.length > MAX_INTENT_PATTERN_LEN) {
          return `intent_pattern exceeds the ${MAX_INTENT_PATTERN_LEN}-char cap.`;
        }
        try {
          new RegExp(ip, 'i');
        } catch {
          return 'intent_pattern is not a valid regular expression.';
        }
        intentPattern = ip;
      }

      const existing = deps.skills.get(name);
      const usableExisting = existing && !existing.error ? existing : undefined;
      const requested =
        args['mode'] === 'edit' ? 'edit' : args['mode'] === 'new' ? 'new' : undefined;
      const mode = requested ?? (usableExisting ? 'edit' : 'new');
      if (mode === 'new' && usableExisting) {
        return `A skill named '${name}' already exists — propose an edit (mode "edit") instead.`;
      }
      if (mode === 'edit' && !usableExisting) {
        return `No usable skill named '${name}' to edit — propose a new one (mode "new").`;
      }

      if (store.countPending() >= MAX_PENDING_PROPOSALS) {
        return 'There are too many pending skill proposals awaiting review; try again once the owner has cleared some.';
      }

      const baseVersion = mode === 'edit' && usableExisting ? usableExisting.version : null;
      const manifest: Record<string, unknown> = {
        kind: 'skill',
        name,
        version: nextVersion(baseVersion),
        modulus: hostRange(deps.hostVersion),
        summary,
        instructions: 'SKILL.md',
        tools: toolsList,
        ...(intentPattern ? { intent_pattern: intentPattern } : {}),
      };

      store.supersedePendingFor(name);
      const proposal = store.create({
        skillName: name,
        baseVersion,
        manifest,
        instructions,
        rationale,
        proposedBy: resolveProposer(ctx),
      });
      void fireNotify(proposal);
      log.info('skill proposed', { id: proposal.id, name, mode });
      return `Proposed skill '${name}' (${mode}) — waiting for the owner's approval. They'll see it on Telegram and in the panel's Skills section.`;
    },
  });

  return { store, manager };
}
