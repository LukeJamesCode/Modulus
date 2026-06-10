import type { Host } from '../../../src/core/modules.js';

const LEARNED_ROUTINE_LIST_INTENT =
  '\\b(learned routine(s)?|auto(matic)? routine(s)?|recurring nudge(s)?|what routines|list.*routine(s)?|my routine(s)?)\\b';
const LEARNED_ROUTINE_DELETE_INTENT =
  '\\b(forget|stop|cancel|delete|remove).*(routine|recurring nudge|auto reminder)\\b';

interface RuleRow {
  id: number;
  title: string;
  cron: string;
  text: string;
  created_at: number;
}

export function register(host: Host): void {
  host.tools.register({
    name: 'learned_routine_list',
    intentPattern: LEARNED_ROUTINE_LIST_INTENT,
    description:
      "List active learned routines (recurring nudges Modulus auto-created from observed patterns). Use for 'what routines have you learned / list my routines'.",
    tier: 'auto',
    parameters: { type: 'object', properties: {} },
    invoke: async (_args, ctx) => {
      const chatId = ctx.chatId ?? host.telegram.chatId;
      const rows = host.db
        .prepare(
          `SELECT id, title, cron, text, created_at FROM routine_rules
           WHERE status='active' AND chat_id=? ORDER BY id`,
        )
        .all(chatId) as RuleRow[];
      if (rows.length === 0) return 'No learned routines yet.';
      return rows
        .map(
          (r) =>
            `[${r.id}] ${r.title} — ${r.cron} (learned ${new Date(r.created_at).toLocaleDateString()})`,
        )
        .join('\n');
    },
  });

  host.tools.register({
    name: 'learned_routine_delete',
    intentPattern: LEARNED_ROUTINE_DELETE_INTENT,
    description:
      "Delete an active learned routine by id or title. Use for 'forget the X routine / stop the recurring nudge'. Prefer matching by title.",
    tier: 'confirm',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'number',
          description: 'Numeric routine id from the `[N]` prefix in `learned_routine_list` output.',
        },
        title: {
          type: 'string',
          description:
            "Substring of the routine's title (case-insensitive). Use when the user names the routine by description rather than id.",
        },
      },
    },
    invoke: async (args, ctx) => {
      const chatId = ctx.chatId ?? host.telegram.chatId;
      const a = args as { id?: number; title?: string };
      if (a.id === undefined && !a.title?.trim()) {
        return 'Provide either an id or a title to identify the routine.';
      }

      let result;
      if (a.id !== undefined) {
        result = host.db
          .prepare(
            `UPDATE routine_rules SET status='deleted', updated_at=?
             WHERE id=? AND chat_id=? AND status='active'`,
          )
          .run(Date.now(), a.id, chatId);
      } else {
        result = host.db
          .prepare(
            `UPDATE routine_rules SET status='deleted', updated_at=?
             WHERE chat_id=? AND status='active' AND lower(title) LIKE lower(?)`,
          )
          .run(Date.now(), chatId, `%${a.title!.trim()}%`);
      }

      if (result.changes === 0) return 'No matching active routine found.';
      if (result.changes === 1) return 'Routine deleted.';
      return `Deleted ${result.changes} routines.`;
    },
  });
}
