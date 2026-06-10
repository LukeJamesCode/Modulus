// Recent-conversation context for a handoff. Codex can't see the chat, so the
// local model used to have to hand-paste the relevant bits into `context` — a
// job a 0.8b model does badly. This pulls the last few user/assistant turns
// straight from core's `messages` table and folds them into the prompt, bounded
// by a turn count and a char budget so we don't blow tokens (or ship more of
// the chat to OpenAI than necessary).

import type { DB } from '../../../src/storage/db.js';

export interface HistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

// Per-turn clip so one giant pasted blob can't dominate the whole budget.
const MAX_TURN_CHARS = 1200;

// Most-recent-last user/assistant turns for a conversation. tool/system rows are
// excluded — Codex wants the human-readable thread, not raw tool payloads.
export function recentTurns(db: DB, conversationId: number, maxTurns: number): HistoryTurn[] {
  if (maxTurns <= 0) return [];
  const rows = db
    .prepare(
      `SELECT role, content FROM messages
        WHERE conversation_id = ? AND role IN ('user', 'assistant')
        ORDER BY id DESC LIMIT ?`,
    )
    .all(conversationId, maxTurns) as Array<{ role: 'user' | 'assistant'; content: string }>;
  return rows.reverse();
}

// The conversation a Telegram chat is currently attached to. The tool path gets
// a conversationId for free; commands only get a chatId, so this maps it.
export function conversationIdForChat(db: DB, chatId: number): number | undefined {
  const row = db
    .prepare(`SELECT current_conversation_id AS id FROM telegram_chats WHERE chat_id = ?`)
    .get(chatId) as { id: number | null } | undefined;
  return row?.id ?? undefined;
}

// Render turns into a chronological prompt block. Walks newest-first so the
// char budget keeps the most recent turns, then re-sorts to chronological. A
// turn whose text equals `exclude` (the task itself — common on auto-route,
// where task === the latest user message) is skipped so it isn't repeated.
export function formatHistory(
  turns: HistoryTurn[],
  opts: { maxChars: number; exclude?: string },
): string {
  const exclude = opts.exclude?.trim();
  const kept: string[] = [];
  let total = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]!;
    const text = t.content.trim();
    if (!text) continue;
    if (exclude && text === exclude) continue;
    const clipped = text.length > MAX_TURN_CHARS ? text.slice(0, MAX_TURN_CHARS) + '…' : text;
    const line = `${t.role === 'user' ? 'User' : 'Modulus'}: ${clipped}`;
    if (total + line.length > opts.maxChars && kept.length > 0) break;
    kept.push(line);
    total += line.length;
  }
  return kept.reverse().join('\n');
}
