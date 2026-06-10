import type { Host } from '../../../src/core/modules.js';
import {
  findTaskByTitle,
  formatTask,
  friendlyTaskError,
  getClient,
  normalizeDue,
} from '../helpers/tasks.js';
import type { TasksClient } from '../api/tasks.js';

const NOT_CONFIGURED = 'Google Tasks is not configured. Run `modulus auth modulus-assistant`.';

const TASK_LIST_INTENT =
  '\\b(list|show|review|check|what|whats|whats?\\s*on|which)\\b.*\\b(task|tasks|todo|todos|to-do|to do|to-dos|to dos|get done|need to do|my list)\\b|^\\s*(tasks|todos|to-dos)\\s*\\??\\s*$';
const TASK_ADD_INTENT =
  '\\b(add|create|new|set|make|put)\\b(?!.*\\b(event|meeting|appointment|calendar|reminder|alarm|timer)\\b).*\\b(task|tasks|todo|todos|to-do|to do|to-dos|to dos|list|my list)\\b|\\b(need to|remember to)\\b(?!.*\\b(at|in \\d+\\s*(minutes?|hours?|days?))\\b)|\\b(task|todo|to-do)\\s*:';
const TASK_DONE_INTENT = '\\b(done|complete|completed|finish|finished|check off|mark.*done|did)\\b';
const TASK_DELETE_INTENT = '\\b(delete|remove|abandon|drop|cancel).*(task|todo|to-do|to do)\\b';
const TASK_LISTS_INTENT = '\\b(task lists?|google task lists?)\\b';

async function resolveTaskId(
  client: TasksClient,
  args: { task_id?: string; task_title?: string; tasklist_id?: string },
  verb: 'complete' | 'delete',
): Promise<{ ok: true; id: string } | { ok: false; message: string }> {
  if (args.task_id?.trim()) {
    return { ok: true, id: args.task_id.trim() };
  }
  if (!args.task_title?.trim()) {
    return {
      ok: false,
      message: `To ${verb} a task, pass either task_title (preferred) or task_id.`,
    };
  }
  const match = await findTaskByTitle(client, args.task_title, args.tasklist_id, true);
  if (match.kind === 'none') {
    return {
      ok: false,
      message: `No Google Task title contains "${args.task_title}". Tell the user there's no such task on their list yet.`,
    };
  }
  if (match.kind === 'many') {
    const titles = match.matches.map((t) => `• ${t.title}`).join('\n');
    return {
      ok: false,
      message:
        `"${args.task_title}" matches ${match.matches.length} tasks — ` +
        `ask the user which one, or pass task_id:\n${titles}`,
    };
  }
  return { ok: true, id: match.task.id };
}

export function register(host: Host): void {
  host.tools.register({
    name: 'tasks_list',
    intentPattern: TASK_LIST_INTENT,
    description:
      "List Google Tasks (TODOs). Use for 'what are my tasks / what's on my todo list / what do I need to do'. Defaults to incomplete only. " +
      'Call the tool via the structured protocol — never write `[tasks_list]` as plain-text reply.',
    tier: 'auto',
    parameters: {
      type: 'object',
      properties: {
        show_completed: {
          type: 'boolean',
          description:
            "Include completed tasks. Default false. Set true only if the user explicitly asks 'show completed'.",
        },
        tasklist_id: {
          type: 'string',
          description:
            "Specific task list id from `tasks_list_tasklists`. Omit to use the user's default list.",
        },
      },
    },
    invoke: async (args, ctx) => {
      const c = getClient(host, ctx.signal);
      if (!c) return NOT_CONFIGURED;
      try {
        const a = args as { show_completed?: boolean; tasklist_id?: string };
        const tasks = await c.listTasks(a.show_completed ?? false, a.tasklist_id);
        if (tasks.length === 0) return 'No tasks.';
        return tasks.map((t) => formatTask(t, { includeId: true })).join('\n');
      } catch (e) {
        return friendlyTaskError(e);
      }
    },
  });

  host.tools.register({
    name: 'tasks_add',
    intentPattern: TASK_ADD_INTENT,
    description:
      "Record a NEW todo on the user's Google Tasks list. DEFAULT for 'add X to my list / put X on my todos / set a task X / I need to X / remember to X' with no specific firing time. " +
      "Copy the user's words into `title` (lightly cleaned). Duplicates are fine — when in doubt, ADD; never refuse the request.",
    tier: 'auto',
    selfReplying: true,
    parameters: {
      type: 'object',
      required: ['title'],
      properties: {
        title: {
          type: 'string',
          description: 'Short task title, e.g. "Buy milk", "Call dentist", "Submit Q2 report".',
        },
        notes: {
          type: 'string',
          description: 'Optional longer notes/description body.',
        },
        due: {
          type: 'string',
          description:
            'Optional due date. Accepts "YYYY-MM-DD" (preferred) or full ISO 8601. Pass ONLY when the user explicitly named a deadline. Omit when the user did not name a deadline.',
        },
        tasklist_id: {
          type: 'string',
          description: 'Task list id (omit for the default list).',
        },
      },
    },
    invoke: async (args, ctx) => {
      const c = getClient(host, ctx.signal);
      if (!c) return NOT_CONFIGURED;
      const a = args as { title: string; notes?: string; due?: string; tasklist_id?: string };
      if (!a.title?.trim()) return 'tasks_add requires a non-empty title.';
      let normalizedDue: string | undefined;
      try {
        normalizedDue = a.due?.trim() ? normalizeDue(a.due) : undefined;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
      try {
        const t = await c.addTask({
          title: a.title.trim(),
          ...(a.notes ? { notes: a.notes } : {}),
          ...(normalizedDue ? { due: normalizedDue } : {}),
          ...(a.tasklist_id ? { tasklistId: a.tasklist_id } : {}),
        });
        return `Added: ${formatTask(t)}`;
      } catch (e) {
        return friendlyTaskError(e);
      }
    },
  });

  host.tools.register({
    name: 'tasks_complete',
    intentPattern: TASK_DONE_INTENT,
    description:
      "Mark a Google Task as DONE. Use for 'I finished X / mark X done / check off X'. Pass `task_title` (preferred) or `task_id`.",
    tier: 'auto',
    parameters: {
      type: 'object',
      properties: {
        task_title: {
          type: 'string',
          description: 'The task name or a unique substring (case-insensitive). Preferred.',
        },
        task_id: {
          type: 'string',
          description: 'Opaque task id from `tasks_list` output. Use only when title is ambiguous.',
        },
        tasklist_id: { type: 'string', description: 'Task list id (omit for default).' },
      },
    },
    invoke: async (args, ctx) => {
      const c = getClient(host, ctx.signal);
      if (!c) return NOT_CONFIGURED;
      const a = args as { task_id?: string; task_title?: string; tasklist_id?: string };
      try {
        const r = await resolveTaskId(c, a, 'complete');
        if (!r.ok) return r.message;
        await c.completeTask(r.id, a.tasklist_id);
        return 'Task marked as completed.';
      } catch (e) {
        return friendlyTaskError(e);
      }
    },
  });

  host.tools.register({
    name: 'tasks_delete',
    intentPattern: TASK_DELETE_INTENT,
    description:
      "Permanently delete a Google Task. Use only when the user ABANDONS a task; for 'I did X' use `tasks_complete`.",
    tier: 'confirm',
    parameters: {
      type: 'object',
      properties: {
        task_title: {
          type: 'string',
          description: 'The task name or a unique substring (case-insensitive). Preferred.',
        },
        task_id: { type: 'string', description: 'Task id from `tasks_list`.' },
        tasklist_id: { type: 'string', description: 'Task list id (omit for default).' },
      },
    },
    invoke: async (args, ctx) => {
      const c = getClient(host, ctx.signal);
      if (!c) return NOT_CONFIGURED;
      const a = args as { task_id?: string; task_title?: string; tasklist_id?: string };
      try {
        const r = await resolveTaskId(c, a, 'delete');
        if (!r.ok) return r.message;
        await c.deleteTask(r.id, a.tasklist_id);
        return 'Task deleted.';
      } catch (e) {
        return friendlyTaskError(e);
      }
    },
  });

  host.tools.register({
    name: 'tasks_list_tasklists',
    intentPattern: TASK_LISTS_INTENT,
    description:
      "List the user's Google Task lists. Only call when the user explicitly asks 'what task lists do I have'.",
    tier: 'auto',
    parameters: { type: 'object', properties: {} },
    invoke: async (_args, ctx) => {
      const c = getClient(host, ctx.signal);
      if (!c) return NOT_CONFIGURED;
      try {
        const lists = await c.listTaskLists();
        if (lists.length === 0) return 'No task lists found.';
        return lists.map((l) => `[${l.id}] ${l.title}`).join('\n');
      } catch (e) {
        return friendlyTaskError(e);
      }
    },
  });
}
