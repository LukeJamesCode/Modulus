// Hive-mind shared memory. One SQLite table (migration 0021) that every agent
// reads and writes: the main chat, module agents, and autonomous workers all
// see the same store, so a fact learned in one place is recallable everywhere.
//
// Recall is FTS5/BM25 keyword search, not embeddings — CPU-cheap (microseconds),
// no extra model to download, works on a Pi 4. An embedding upgrade can layer
// on later without changing this module's interface.
//
// Write paths:
// - the `remember` tool (auto tier, any agent or the main chat) → global store
// - the background extraction job (memory-extraction.ts): 0–2 durable user facts
//   per chat turn, source 'extraction', global
// - promoteFindings(): an agent task's record_finding notes, distilled into rows
//   tagged `agent:<name>` and scoped to that agent's namespace (wired in start.ts)
//
// Namespaces (migration 0032): agent_id NULL is the shared hive mind (user facts
// + extraction); a value is one agent's private namespace (its findings). An
// agent run recalls global ∪ its own; the main chat recalls global only.
//
// Read path: the orchestrator's memoryProvider hook calls renderForPrompt(message,
// agentId) per turn; the result fills the `memory` slot of the deterministic
// prefix (system → tools → memory → session → history). The dreaming pass
// (dreaming.ts) periodically calls consolidate() to promote/decay rows.

import { createHash } from 'node:crypto';
import type { DB } from '../storage/db.js';
import type { Logger } from '../util/log.js';
import type { ToolHandler, ToolRegistry } from './tools.js';

export const REMEMBER_TOOL_NAME = 'remember';
export const FORGET_TOOL_NAME = 'forget';

// Memories are facts, not documents. Longer content is truncated on store so
// a runaway model can't stuff whole transcripts into the prompt prefix.
export const MEMORY_MAX_CHARS = 600;
// Default table cap. Eviction removes lowest-importance, least-recently-used
// rows first, so an importance-3 fact survives while importance-1 rows remain.
export const MEMORY_DEFAULT_MAX_ROWS = 2000;
// Default top-K injected into the prompt.
export const MEMORY_DEFAULT_RECALL_LIMIT = 6;

export interface MemoryRow {
  id: number;
  content: string;
  scope: string;
  source: string;
  importance: number;
  // NULL = global/shared (the hive mind); a value scopes the row to one agent's
  // private namespace (migration 0032).
  agentId: number | null;
  createdAt: number;
  lastUsedAt: number | null;
  uses: number;
}

export interface MemoryOptions {
  db: DB;
  log: Logger;
  // When provided, the `remember` and `forget` tools are registered.
  tools?: ToolRegistry;
  maxRows?: number;
  recallLimit?: number;
  now?: () => Date;
}

export interface ConsolidateResult {
  // Rows whose importance was bumped because they keep proving useful.
  promoted: number;
  // Stale, never-useful extraction rows pruned.
  decayed: number;
}

export interface MemoryStore {
  // Store a fact. Returns the row id; a duplicate (same normalised content)
  // returns the existing id and keeps the higher importance. agentId scopes the
  // row to one agent's private namespace; omit (or NULL) for the global store.
  remember(input: {
    content: string;
    source: string;
    importance?: number;
    agentId?: number | null;
  }): number;
  // BM25 search across the whole store (every namespace). Empty query or no
  // match returns []. Used by the owner's memory browser and `forget`.
  recall(query: string, limit?: number): MemoryRow[];
  // BM25 search filtered in SQL to what an agent would actually recall: global
  // ∪ that agent's private namespace when agentId is given, else global only.
  // Used by the browser's agent-scoped search so high-ranked private rows past
  // the limit aren't dropped and global rows still surface.
  recallScoped(query: string, agentId: number | undefined, limit?: number): MemoryRow[];
  // Formatted prompt block for this turn's message, or undefined when nothing
  // relevant is stored. Bumps last_used_at/uses on the returned rows. When
  // agentId is given, recalls global ∪ that agent's namespace; otherwise the
  // main chat's global-only view.
  renderForPrompt(message: string, agentId?: number): string | undefined;
  // Delete matching rows (any namespace); returns how many were removed.
  forget(query: string): number;
  // Drop an agent's entire private namespace, for agent deletion cleanup.
  forgetAgent(agentId: number): number;
  // Promote an agent task's findings into that agent's namespace (agentId) or
  // the global store (omit). Returns rows stored.
  promoteFindings(findings: string[], agentName: string, agentId?: number | null): number;
  // Deterministic "dreaming" consolidation: bump importance of frequently
  // recalled facts, prune stale never-useful extraction noise. Returns counts.
  consolidate(opts: { minUses: number; maxStaleMs: number }): ConsolidateResult;
  // Browser/UI surface. agentId filters to one namespace (its private rows).
  list(limit?: number, offset?: number, agentId?: number): MemoryRow[];
  remove(id: number): boolean;
  count(): number;
}

const SELECT_COLS = `id, content, scope, source, importance, agent_id AS agentId,
  created_at AS createdAt, last_used_at AS lastUsedAt, uses`;

// Same columns, aliased for the memories_fts JOIN (m.* form).
const FTS_COLS = `m.id, m.content, m.scope, m.source, m.importance, m.agent_id AS agentId,
  m.created_at AS createdAt, m.last_used_at AS lastUsedAt, m.uses`;

// Words too common to discriminate anything. Tiny on purpose — BM25 already
// down-weights frequent terms; this just keeps junk out of the MATCH query.
const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'are',
  'was',
  'you',
  'your',
  'have',
  'has',
  'had',
  'that',
  'this',
  'with',
  'what',
  'when',
  'where',
  'who',
  'how',
  'why',
  'can',
  'could',
  'would',
  'should',
  'about',
  'from',
  'they',
  'them',
  'will',
  'please',
  'tell',
  'does',
  'did',
  'not',
  'all',
  'any',
  'its',
  // 2-char function words: now reachable since the tokenizer keeps 2-char tokens
  // (to let AI, JS, Go, OS, UI, DB through). Tech 2-char terms are deliberately
  // absent here so they survive.
  'of',
  'to',
  'in',
  'is',
  'it',
  'on',
  'at',
  'as',
  'an',
  'be',
  'by',
  'or',
  'if',
  'so',
  'no',
  'do',
  'my',
  'me',
  'we',
  'he',
  'us',
  'up',
  'am',
]);

// Build a safe FTS5 MATCH expression from free text. Tokens are quoted, so
// user input can never inject FTS query syntax (NEAR, column filters, etc.).
// 2-char tokens are kept (AI, JS, Go, OS, UI, DB) — discarding them missed a
// whole class of common product/tech terms; the stopword list and the BM25
// rank still down-weight noise.
export function ftsQueryFromText(text: string, maxTerms = 12): string {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const m of text.toLowerCase().matchAll(/[a-z0-9]{2,}/g)) {
    const tok = m[0];
    if (STOPWORDS.has(tok) || seen.has(tok)) continue;
    seen.add(tok);
    terms.push(`"${tok}"`);
    if (terms.length >= maxTerms) break;
  }
  return terms.join(' OR ');
}

function normalize(content: string): string {
  return content.trim().replace(/\s+/g, ' ');
}

function hashContent(normalized: string): string {
  return createHash('sha256').update(normalized.toLowerCase()).digest('hex');
}

function clampImportance(v: unknown): number {
  const n = typeof v === 'number' ? Math.round(v) : Number.parseInt(String(v ?? ''), 10);
  if (Number.isNaN(n)) return 1;
  return Math.max(1, Math.min(3, n));
}

export function setupMemory(opts: MemoryOptions): MemoryStore {
  const log = opts.log.child({ mod: 'memory' });
  const db = opts.db;
  const maxRows = opts.maxRows ?? MEMORY_DEFAULT_MAX_ROWS;
  const recallLimit = opts.recallLimit ?? MEMORY_DEFAULT_RECALL_LIMIT;
  const now = opts.now ?? (() => new Date());

  function remember(input: {
    content: string;
    source: string;
    importance?: number;
    agentId?: number | null;
  }): number {
    const content = normalize(input.content).slice(0, MEMORY_MAX_CHARS);
    if (!content) throw new Error('memory content is empty');
    const importance = clampImportance(input.importance ?? 1);
    const agentId = input.agentId ?? null;
    const hash = hashContent(content);
    const existing = db
      .prepare(`SELECT id, importance FROM memories WHERE content_hash = ?`)
      .get(hash) as { id: number; importance: number } | undefined;
    if (existing) {
      // Same fact re-learned: keep the stronger importance, refresh recency.
      // Scope is left as first-learned — a fact promoted globally stays global.
      db.prepare(`UPDATE memories SET importance = ?, last_used_at = ? WHERE id = ?`).run(
        Math.max(existing.importance, importance),
        now().getTime(),
        existing.id,
      );
      return existing.id;
    }
    const r = db
      .prepare(
        `INSERT INTO memories (content, content_hash, source, importance, agent_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(content, hash, input.source, importance, agentId, now().getTime());
    evictOverflow();
    log.debug('memory stored', { id: Number(r.lastInsertRowid), source: input.source });
    return Number(r.lastInsertRowid);
  }

  function evictOverflow(): void {
    const total = count();
    if (total <= maxRows) return;
    const excess = total - maxRows;
    db.prepare(
      `DELETE FROM memories WHERE id IN (
         SELECT id FROM memories
         ORDER BY importance ASC, COALESCE(last_used_at, created_at) ASC
         LIMIT ?
       )`,
    ).run(excess);
    log.info('memory evicted', { n: excess });
  }

  function recall(query: string, limit = recallLimit): MemoryRow[] {
    const match = ftsQueryFromText(query);
    if (!match) return [];
    return db
      .prepare(
        `SELECT ${FTS_COLS}
         FROM memories_fts f JOIN memories m ON m.id = f.rowid
         WHERE memories_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(match, limit) as MemoryRow[];
  }

  // Prompt recall, namespace-aware: global ∪ one agent's private rows when an
  // agentId is given, else global only (the main chat). Separate from recall(),
  // which scans every namespace for the owner's browser and `forget`.
  function recallScoped(
    query: string,
    agentId: number | undefined,
    limit = recallLimit,
  ): MemoryRow[] {
    const match = ftsQueryFromText(query);
    if (!match) return [];
    const scope =
      agentId === undefined
        ? 'AND m.agent_id IS NULL'
        : 'AND (m.agent_id IS NULL OR m.agent_id = ?)';
    const stmt = db.prepare(
      `SELECT ${FTS_COLS}
       FROM memories_fts f JOIN memories m ON m.id = f.rowid
       WHERE memories_fts MATCH ? ${scope}
       ORDER BY rank
       LIMIT ?`,
    );
    const rows = agentId === undefined ? stmt.all(match, limit) : stmt.all(match, agentId, limit);
    return rows as MemoryRow[];
  }

  function renderForPrompt(message: string, agentId?: number): string | undefined {
    const rows = recallScoped(message, agentId);
    if (rows.length === 0) return undefined;
    const t = now().getTime();
    const bump = db.prepare(`UPDATE memories SET last_used_at = ?, uses = uses + 1 WHERE id = ?`);
    const lines = rows.map((r) => {
      bump.run(t, r.id);
      return `- ${r.content}`;
    });
    return ['Long-term memory (shared across all agents — may be relevant):', ...lines].join('\n');
  }

  function forget(query: string): number {
    const rows = recall(query, 50);
    if (rows.length === 0) return 0;
    const del = db.prepare(`DELETE FROM memories WHERE id = ?`);
    for (const r of rows) del.run(r.id);
    log.info('memories forgotten', { n: rows.length });
    return rows.length;
  }

  function forgetAgent(agentId: number): number {
    const n = db.prepare(`DELETE FROM memories WHERE agent_id = ?`).run(agentId).changes;
    if (n > 0) log.info('agent memories forgotten', { agentId, n });
    return n;
  }

  function promoteFindings(findings: string[], agentName: string, agentId?: number | null): number {
    let stored = 0;
    for (const note of findings) {
      const content = normalize(note);
      if (!content) continue;
      try {
        remember({
          content,
          source: `agent:${agentName}`,
          importance: 2,
          agentId: agentId ?? null,
        });
        stored++;
      } catch (e) {
        log.warn('finding promotion failed', {
          agent: agentName,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return stored;
  }

  // Deterministic "dreaming" pass (no model call). Promote facts that keep
  // earning recall, then prune extraction noise that never proved useful and has
  // aged out. Only ever deletes importance-1, uses-0, source='extraction' rows —
  // user facts, agent findings, and anything importance ≥ 2 are immune.
  function consolidate(opts: { minUses: number; maxStaleMs: number }): ConsolidateResult {
    const cutoff = now().getTime() - opts.maxStaleMs;
    const run = db.transaction((): ConsolidateResult => {
      const promoted = db
        .prepare(
          `UPDATE memories SET importance = importance + 1 WHERE importance < 3 AND uses >= ?`,
        )
        .run(opts.minUses).changes;
      const decayed = db
        .prepare(
          `DELETE FROM memories
           WHERE source = 'extraction' AND importance = 1 AND uses = 0 AND created_at < ?`,
        )
        .run(cutoff).changes;
      return { promoted, decayed };
    });
    const result = run();
    if (result.promoted > 0 || result.decayed > 0) log.info('memory consolidated', { ...result });
    return result;
  }

  function list(limit = 100, offset = 0, agentId?: number): MemoryRow[] {
    if (agentId !== undefined) {
      return db
        .prepare(
          `SELECT ${SELECT_COLS} FROM memories WHERE agent_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        )
        .all(agentId, limit, offset) as MemoryRow[];
    }
    return db
      .prepare(`SELECT ${SELECT_COLS} FROM memories ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(limit, offset) as MemoryRow[];
  }

  function remove(id: number): boolean {
    return db.prepare(`DELETE FROM memories WHERE id = ?`).run(id).changes > 0;
  }

  function count(): number {
    return (db.prepare(`SELECT COUNT(*) AS n FROM memories`).get() as { n: number }).n;
  }

  if (opts.tools) registerTools(opts.tools);

  function registerTools(tools: ToolRegistry): void {
    const rememberTool: ToolHandler = {
      name: REMEMBER_TOOL_NAME,
      description:
        'Save a durable fact to shared long-term memory (visible to every agent in future ' +
        'conversations). Use for stable facts worth keeping: preferences, names, decisions, ' +
        'recurring context. Not for transient chit-chat. Keep it to one short sentence.',
      parameters: {
        type: 'object',
        required: ['content'],
        properties: {
          content: {
            type: 'string',
            description: 'The fact to remember, as one short self-contained sentence.',
          },
          importance: {
            type: 'integer',
            description: '1 (default) to 3 (never evict before less important memories).',
          },
        },
      },
      tier: 'auto',
      selfReplying: true,
      invoke: async (args) => {
        const content = String(args['content'] ?? '').trim();
        if (!content) return 'Error: `content` is empty. Provide the fact to remember.';
        const id = remember({
          content,
          source: 'user',
          importance: clampImportance(args['importance'] ?? 1),
        });
        return `Remembered (#${id}).`;
      },
    };
    const forgetTool: ToolHandler = {
      name: FORGET_TOOL_NAME,
      description:
        'Delete facts from shared long-term memory that match a query. Use only when the user ' +
        'explicitly asks to forget or correct stored information.',
      parameters: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'Keywords describing the memories to delete.' },
        },
      },
      // Destroying shared state needs a human yes — and in an unattended agent
      // run the confirm tier fails closed, which is exactly right here.
      tier: 'confirm',
      selfReplying: true,
      confirmPrompt: (args) => `Forget stored memories matching "${String(args['query'] ?? '')}"?`,
      invoke: async (args) => {
        const query = String(args['query'] ?? '').trim();
        if (!query) return 'Error: `query` is empty. Provide keywords for what to forget.';
        const n = forget(query);
        return n === 0
          ? 'No matching memories found.'
          : `Forgot ${n} memor${n === 1 ? 'y' : 'ies'}.`;
      },
    };
    tools.register(rememberTool);
    tools.register(forgetTool);
  }

  return {
    remember,
    recall,
    recallScoped,
    renderForPrompt,
    forget,
    forgetAgent,
    promoteFindings,
    consolidate,
    list,
    remove,
    count,
  };
}
