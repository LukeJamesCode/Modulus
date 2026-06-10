// Tasks helpers: credential loading, client factory, title resolution, and formatting.
// getCredentials reads the unified google_* keys.

import type { Host } from '../../../src/core/modules.js';
import {
  createTasksClient,
  TasksApiError,
  type TasksAccessTokenCache,
  type Task,
  type TasksClient,
  type TasksCredentials,
} from '../api/tasks.js';
import { readGoogleOAuth } from './google-creds.js';

// Separate WeakMap from helpers/calendar.ts — keeps the two token caches isolated.
const tokenCaches = new WeakMap<Host, { current: TasksAccessTokenCache | null }>();

export function getCredentials(host: Host): TasksCredentials | null {
  const base = readGoogleOAuth(host);
  if (!base) return null;
  return { ...base, default_tasklist: host.settings.get<string>('default_tasklist', '@default')! };
}

export function getClient(host: Host, signal?: AbortSignal): TasksClient | null {
  const creds = getCredentials(host);
  if (!creds) return null;
  let cache = tokenCaches.get(host);
  if (!cache) {
    cache = { current: null };
    tokenCaches.set(host, cache);
  }
  return createTasksClient({ creds, cache, ...(signal ? { signal } : {}) });
}

// Default rendering is for human eyes (Telegram chat, /todos): no IDs, since
// Google Task IDs are opaque ~50-char strings that just clutter the message.
// The tool-facing path passes `includeId: true` because the LLM uses the id
// to call `tasks_complete` / `tasks_delete` — it must never echo it back.
export function formatTask(
  t: { id: string; title: string; due?: string; notes?: string },
  opts: { includeId?: boolean } = {},
): string {
  let line = t.title;
  if (t.due) line += ` (due ${formatDueDate(t.due)})`;
  if (t.notes) line += `\n    ${t.notes.slice(0, 80)}`;
  if (opts.includeId) line += `  [id:${t.id}]`;
  return line;
}

// Locale-independent ISO date for display ("2026-05-09"). Google Tasks ignores
// the time component of `due`, so showing "2026-05-09 03:00 BST" is misleading.
function formatDueDate(rfc3339: string): string {
  const d = new Date(rfc3339);
  if (Number.isNaN(d.getTime())) return rfc3339;
  return d.toISOString().slice(0, 10);
}

// Accept either "YYYY-MM-DD" or full RFC3339, hand Google midnight-UTC RFC3339.
export function normalizeDue(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('due date is empty');
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return `${trimmed}T00:00:00.000Z`;
  }
  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`invalid due date "${input}" — use YYYY-MM-DD or full ISO 8601`);
  }
  return d.toISOString();
}

// Local-calendar today as YYYY-MM-DD. Used as the default `due` when the user
// adds a task without naming a deadline.
export function todayLocalIsoDate(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Title resolver shared by tasks_complete / tasks_delete / /done.
export type TitleMatch =
  | { kind: 'one'; task: Task }
  | { kind: 'none' }
  | { kind: 'many'; matches: Task[] };

// Common filler words the 0.8b model often prepends to a task title ("the project
// report", "my groceries list"). Stripping them before matching lets a query like
// "the project report" still hit a stored task titled "Finish project report".
const TASK_QUERY_STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'my',
  'our',
  'that',
  'this',
  'task',
  'todo',
  'to-do',
  'item',
]);

function tokenizeForTask(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

function contentTokens(s: string): string[] {
  return tokenizeForTask(s).filter((w) => !TASK_QUERY_STOPWORDS.has(w));
}

export async function findTaskByTitle(
  client: TasksClient,
  query: string,
  tasklistId?: string,
  includeCompleted = false,
): Promise<TitleMatch> {
  const tasks = await client.listTasks(includeCompleted, tasklistId);
  const needle = query.trim().toLowerCase();
  if (!needle) return { kind: 'none' };

  // 1. Exact match on the full title.
  const exact = tasks.filter((t) => t.title.toLowerCase() === needle);
  if (exact.length > 0) {
    return exact.length === 1 ? { kind: 'one', task: exact[0]! } : { kind: 'many', matches: exact };
  }

  // 2. Substring match (covers most LLM phrasings verbatim).
  const substring = tasks.filter((t) => t.title.toLowerCase().includes(needle));
  if (substring.length > 0) {
    return substring.length === 1
      ? { kind: 'one', task: substring[0]! }
      : { kind: 'many', matches: substring };
  }

  // 3. Content-token subset: drop filler words from the query, require every
  // remaining token to appear in the task title. Catches "the project report"
  // against "Finish project report" and "groceries" against "Buy groceries".
  const needleTokens = contentTokens(needle);
  if (needleTokens.length === 0) return { kind: 'none' };
  const tokenMatches = tasks.filter((t) => {
    const titleTokens = new Set(tokenizeForTask(t.title));
    return needleTokens.every((w) => titleTokens.has(w));
  });
  if (tokenMatches.length === 0) return { kind: 'none' };
  if (tokenMatches.length === 1) return { kind: 'one', task: tokenMatches[0]! };
  return { kind: 'many', matches: tokenMatches };
}

// Translate Google Tasks API failures into something a small model can act on.
export function friendlyTaskError(e: unknown): string {
  if (e instanceof TasksApiError) {
    if (e.status === 401 || e.status === 403) {
      return 'Google Tasks auth failed (scope missing). ' + 'Run: modulus auth modulus-assistant';
    }
    if (e.status === 404) {
      return 'Task or task list not found (it may have been deleted, or the id is wrong).';
    }
    if (e.status === 429) return 'Google Tasks rate limit hit. Try again in a minute.';
    if (e.status >= 500) return 'Google Tasks is having a problem. Try again shortly.';
    return `Google Tasks error (${e.status}): ${e.message}`;
  }
  return e instanceof Error ? e.message : String(e);
}
