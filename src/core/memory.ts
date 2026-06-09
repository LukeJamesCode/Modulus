// Hive-mind shared memory. One SQLite table (migration 0021) that every agent
// reads and writes: the main chat, module agents, and autonomous workers all
// see the same store, so a fact learned in one place is recallable everywhere.
//
// Recall is FTS5/BM25 keyword search, not embeddings — CPU-cheap (microseconds),
// no extra model to download, works on a Pi 4. An embedding upgrade can layer
// on later without changing this module's interface.
//
// Write paths:
// - the `remember` tool (auto tier, any agent or the main chat)
// - promoteFindings(): an agent task's record_finding notes, distilled into
//   rows tagged `agent:<name>` when the task completes (wired in start.ts)
// - a future background extraction job (calls remember() directly)
//
// Read path: the orchestrator's memoryProvider hook calls renderForPrompt()
// per turn; the result fills the `memory` slot of the deterministic prefix
// (system → tools → memory → session → history).

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

export interface MemoryStore {
  // Store a fact. Returns the row id; a duplicate (same normalised content)
  // returns the existing id and keeps the higher importance.
  remember(input: { content: string; source: string; importance?: number }): number;
  // BM25 search. Empty query or no match returns [].
  recall(query: string, limit?: number): MemoryRow[];
  // Formatted prompt block for this turn's message, or undefined when nothing
  // relevant is stored. Bumps last_used_at/uses on the returned rows.
  renderForPrompt(message: string): string | undefined;
  // Delete matching rows; returns how many were removed.
  forget(query: string): number;
  // Promote an agent task's findings into shared memory. Returns rows stored.
  promoteFindings(findings: string[], agentName: string): number;
  // Browser/UI surface.
  list(limit?: number, offset?: number): MemoryRow[];
  remove(id: number): boolean;
  count(): number;
}

const SELECT_COLS = `id, content, scope, source, importance,
  created_at AS createdAt, last_used_at AS lastUsedAt, uses`;

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
]);

// Build a safe FTS5 MATCH expression from free text. Tokens are quoted, so
// user input can never inject FTS query syntax (NEAR, column filters, etc.).
export function ftsQueryFromText(text: string, maxTerms = 12): string {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const m of text.toLowerCase().matchAll(/[a-z0-9]{3,}/g)) {
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

  function remember(input: { content: string; source: string; importance?: number }): number {
    const content = normalize(input.content).slice(0, MEMORY_MAX_CHARS);
    if (!content) throw new Error('memory content is empty');
    const importance = clampImportance(input.importance ?? 1);
    const hash = hashContent(content);
    const existing = db
      .prepare(`SELECT id, importance FROM memories WHERE content_hash = ?`)
      .get(hash) as { id: number; importance: number } | undefined;
    if (existing) {
      // Same fact re-learned: keep the stronger importance, refresh recency.
      db.prepare(`UPDATE memories SET importance = ?, last_used_at = ? WHERE id = ?`).run(
        Math.max(existing.importance, importance),
        now().getTime(),
        existing.id,
      );
      return existing.id;
    }
    const r = db
      .prepare(
        `INSERT INTO memories (content, content_hash, source, importance, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(content, hash, input.source, importance, now().getTime());
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
        `SELECT m.id, m.content, m.scope, m.source, m.importance,
                m.created_at AS createdAt, m.last_used_at AS lastUsedAt, m.uses
         FROM memories_fts f JOIN memories m ON m.id = f.rowid
         WHERE memories_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(match, limit) as MemoryRow[];
  }

  function renderForPrompt(message: string): string | undefined {
    const rows = recall(message);
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

  function promoteFindings(findings: string[], agentName: string): number {
    let stored = 0;
    for (const note of findings) {
      const content = normalize(note);
      if (!content) continue;
      try {
        remember({ content, source: `agent:${agentName}`, importance: 2 });
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

  function list(limit = 100, offset = 0): MemoryRow[] {
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

  return { remember, recall, renderForPrompt, forget, promoteFindings, list, remove, count };
}
