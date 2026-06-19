// Pure command logic for the Telegram scheduling surface: /remind, /every,
// /schedules, /schedule cancel. Kept out of the grammY adapter so it unit-tests
// without Telegram I/O and can be reused by other chat surfaces. All the real
// work (parse → create) lives in core/schedule-tools; this layer only splits
// command strings and renders replies.

import {
  createScheduleFromText,
  describeSchedule,
  formatCreatedReply,
  type SchedulingDeps,
} from '../core/schedule-tools.js';

const REMIND_USAGE = 'Usage: /remind <when>, <what> — e.g. /remind tomorrow at 9, call the dentist';
const EVERY_USAGE = 'Usage: /every <when>, <what> — e.g. /every weekday at 8am, take your pills';

// Split "<when>, <what>" on the first comma. The comma is the separator because
// either half can contain spaces (and the time half rarely contains a comma).
function splitWhenWhat(
  arg: string,
  usage: string,
): { when: string; what: string } | { error: string } {
  const i = arg.indexOf(',');
  if (i === -1) return { error: usage };
  const when = arg.slice(0, i).trim();
  const what = arg.slice(i + 1).trim();
  if (!when || !what) return { error: usage };
  return { when, what };
}

async function create(
  deps: SchedulingDeps,
  chatId: number,
  arg: string,
  recurringHint: boolean,
  usage: string,
): Promise<string> {
  const parts = splitWhenWhat(arg.trim(), usage);
  if ('error' in parts) return parts.error;
  const result = await createScheduleFromText(deps, {
    chatId,
    when: parts.when,
    what: parts.what,
    recurringHint,
  });
  if ('error' in result) return `Couldn't schedule that: ${result.error}`;
  return formatCreatedReply(result, deps.timeZone);
}

// /remind <when>, <what> — one-time (or whatever the phrase says) reminder.
export function handleRemind(deps: SchedulingDeps, chatId: number, arg: string): Promise<string> {
  return create(deps, chatId, arg, false, REMIND_USAGE);
}

// /every <when>, <what> — repeating reminder. "weekday at 8" is coerced to
// "every weekday at 8" so the leading "every" is optional.
export function handleEvery(deps: SchedulingDeps, chatId: number, arg: string): Promise<string> {
  return create(deps, chatId, arg, true, EVERY_USAGE);
}

// /schedules — list this chat's active reminders.
export function handleScheduleList(deps: SchedulingDeps, chatId: number): string {
  const rows = deps.store.list({ chatId, active: true, limit: 50 });
  if (rows.length === 0) {
    return 'No active reminders. Set one with /remind <when>, <what> or /every <when>, <what>.';
  }
  const lines = rows.map((s) => `#${s.id} · ${describeSchedule(s, deps.timeZone)} — ${s.prompt}`);
  return ['⏰ Your reminders:', ...lines, '', 'Cancel one with /schedule cancel <id>.'].join('\n');
}

// /schedule [cancel <id> | cancel all] — defaults to a short usage line.
export function handleScheduleCommand(deps: SchedulingDeps, chatId: number, arg: string): string {
  const trimmed = arg.trim();
  const m = /^cancel\s+(.+)$/i.exec(trimmed);
  if (!m) {
    return 'Usage: /schedule cancel <id> — or /schedules to list them.';
  }
  const target = m[1]!.trim().toLowerCase();
  if (target === 'all') {
    const rows = deps.store.list({ chatId, active: true, limit: 200 });
    let n = 0;
    for (const s of rows) if (deps.store.removeForChat(chatId, s.id)) n += 1;
    return n > 0 ? `Cancelled ${n} reminder${n === 1 ? '' : 's'}.` : 'No reminders to cancel.';
  }
  const id = Number.parseInt(target, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return 'Usage: /schedule cancel <id> — the id is the number from /schedules.';
  }
  return deps.store.removeForChat(chatId, id)
    ? `Cancelled reminder #${id}.`
    : `No reminder #${id} in this chat. Run /schedules to see them.`;
}
