import type { Host } from '../../../src/core/modules.js';
import { formatEventLine, getClient, hasClockTime, todayRangeIso } from '../helpers/calendar.js';
import { briefingTimeZone } from '../gather.js';

const NOT_CONFIGURED = 'Google Calendar is not configured. Run `modulus auth modulus-assistant`.';

const CALENDAR_LIST_INTENT =
  '\\b(calendar|event|events|meeting|meetings|appointment|appointments|free|available|what.*scheduled|what.*on|do i have|am i free)\\b';
const CALENDAR_ADD_INTENT =
  '\\b(schedule|add|create|book|put).*(event|meeting|appointment|calendar)' +
  '|\\b(event|meeting|appointment)\\b.*\\b(at|on|tomorrow|today|next|this|for)\\b' +
  '|\\b(add|schedule|book|put|create)\\b.*\\b(\\d{1,2}(:\\d{2})?\\s*(am|pm)|\\d{1,2}\\s*(am|pm)|\\d{1,2}:\\d{2})\\b';
// Match a delete verb anywhere alongside either an event-noun OR a date/time
// phrase. The old pattern required the user to literally say "event/meeting/
// appointment/calendar", so "remove pizza on may 30th" left the delete tool
// out of the per-turn manifest entirely and the model hallucinated success.
const CALENDAR_DELETE_INTENT =
  '\\b(cancel|delete|remove|drop|get rid of|nuke).*(event|meeting|appointment|calendar)\\b' +
  '|\\b(cancel|delete|remove|drop|get rid of|nuke)\\b.*\\b(today|tomorrow|tonight|on|this|next|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|mon|tue|wed|thu|fri|sat|sun|\\d{1,2}(st|nd|rd|th)?)\\b';

export function register(host: Host): void {
  host.tools.register({
    name: 'calendar_list_events',
    intentPattern: CALENDAR_LIST_INTENT,
    description:
      "List Google Calendar events for a day or range. ALWAYS call for 'do I have anything tomorrow / am I free at 3pm / what's on my calendar / show my events this week'. " +
      'Defaults to today. For a specific date the user named, set `time_min` to the start of that local day and `time_max` to the start of the next — do not widen. ' +
      "Read-only: list every event in the result, repeat each line's date verbatim, never claim an event is cancelled.",
    tier: 'auto',
    parameters: {
      type: 'object',
      properties: {
        time_min: {
          type: 'string',
          description:
            'ISO 8601 start of the range, inclusive (e.g. 2026-05-02T00:00:00-06:00). Omit to default to today.',
        },
        time_max: {
          type: 'string',
          description: 'ISO 8601 end of the range, exclusive. Omit to default to end-of-today.',
        },
        max: {
          type: 'number',
          description: 'Max events to return. Default 25. Bump up only for week/month views.',
        },
      },
    },
    invoke: async (args, ctx) => {
      const c = getClient(host, ctx.signal);
      if (!c) return NOT_CONFIGURED;
      const a = args as { time_min?: string; time_max?: string; max?: number };
      const parseBound = (s: string): Date | null => {
        const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
        if (dateOnly) {
          const [, y, m, d] = dateOnly;
          return new Date(Number(y), Number(m) - 1, Number(d));
        }
        const t = new Date(s);
        return Number.isNaN(t.getTime()) ? null : t;
      };
      let range: { timeMin: string; timeMax: string };
      if (a.time_min && a.time_max) {
        const s = parseBound(a.time_min);
        const e = parseBound(a.time_max);
        if (!s) return `Invalid time_min: ${a.time_min}`;
        if (!e) return `Invalid time_max: ${a.time_max}`;
        range = { timeMin: s.toISOString(), timeMax: e.toISOString() };
      } else if (a.time_min) {
        const start = parseBound(a.time_min);
        if (!start) return `Invalid time_min: ${a.time_min}`;
        const end = new Date(start);
        end.setDate(end.getDate() + 1);
        range = { timeMin: start.toISOString(), timeMax: end.toISOString() };
      } else if (a.time_max) {
        const end = parseBound(a.time_max);
        if (!end) return `Invalid time_max: ${a.time_max}`;
        const start = new Date(end);
        start.setDate(start.getDate() - 1);
        range = { timeMin: start.toISOString(), timeMax: end.toISOString() };
      } else {
        range = todayRangeIso(new Date(), briefingTimeZone(host));
      }
      const events = await c.listEvents({
        ...range,
        ...(a.max ? { max: a.max } : { max: 25 }),
      });
      if (events.length === 0) {
        return `No events between ${range.timeMin} and ${range.timeMax}.`;
      }
      const lines = events.map((ev) => formatEventLine(ev)).join('\n');
      const idMap = events.map((ev) => `${ev.summary}=${ev.id}`).join('; ');
      return `${lines}\nevent_ids: ${idMap}`;
    },
  });

  host.tools.register({
    name: 'calendar_add_event',
    intentPattern: CALENDAR_ADD_INTENT,
    description:
      "Create a Google Calendar event with structured start/end. DEFAULT for any event-add request, including dentist/doctor/haircut/DMV/school appointments (you record on the user's calendar, you don't book with the provider). " +
      "Resolve the date yourself from the system prompt's current date; default morning=09:00, afternoon=14:00, evening=18:00 when no clock time. Title = user's noun phrase verbatim. " +
      'For all-day events: `all_day: true`, YYYY-MM-DD start/end, `end` = final included date.',
    tier: 'auto',
    selfReplying: true,
    parameters: {
      // `end` is conceptually required but we mark only `summary` and `start`
      // as required at the schema level. The 0.8b/2b chat models routinely
      // omit `end` even when the description says it's required — the
      // validator was then rejecting with "missing required property 'end'"
      // and the tool never ran. Instead we default end ourselves in invoke
      // (start + 1 hour for timed events, same as start for all-day).
      type: 'object',
      required: ['summary', 'start'],
      properties: {
        summary: {
          type: 'string',
          description:
            "Event title. Use the user's own noun verbatim — do NOT append 'meeting', 'session', or 'appointment' that the user did not say.",
        },
        start: {
          type: 'string',
          description:
            'ISO 8601 start with timezone offset, e.g. 2026-05-01T13:00:00-06:00. Must be machine-parseable — if you only have a phrase, use `calendar_quick_add`.',
        },
        end: {
          type: 'string',
          description:
            'For timed events: ISO 8601 end with timezone offset. For all-day events: YYYY-MM-DD final included date. If omitted, defaults to start + 1 hour (timed) or the same date (all-day).',
        },
        all_day: {
          type: 'boolean',
          description:
            'Set true when the user gives a date or date range without a clock time (graduations, trips, birthdays).',
        },
        description: {
          type: 'string',
          description: 'Optional event notes/description body.',
        },
      },
    },
    invoke: async (args, ctx) => {
      const c = getClient(host, ctx.signal);
      if (!c) return NOT_CONFIGURED;
      const a = args as {
        summary: string;
        start: string;
        end?: string;
        all_day?: boolean;
        description?: string;
      };
      // Correct the model's clock conversion against the user's verbatim
      // phrasing. qwen3.5:2b mis-emits ISO times ~30% of the time ("9pm to
      // 10pm" → 20:00–21:00 or 09:00–10:00) — but "9pm" → 21:00 is
      // deterministic, so code owns it. Only runs when the user message has
      // explicit am/pm tokens AND the call is not all-day.
      let userStart = a.start;
      let userEnd = a.end?.trim();
      const allDayShortcut =
        a.all_day === true || isDateOnly(a.start) || (userEnd !== undefined && isDateOnly(userEnd));
      if (!allDayShortcut && ctx.userMessage) {
        const wanted = extractClockTimes(ctx.userMessage);
        const wantedStart = wanted[0];
        if (wantedStart) {
          const corrected = correctLocalTime(userStart, wantedStart);
          if (corrected && corrected !== userStart) {
            ctx.log.info('calendar_add_event: corrected start to match user clock time', {
              from: userStart,
              to: corrected,
              wanted: wantedStart,
            });
            userStart = corrected;
          }
          const wantedEnd = wanted[1];
          if (wantedEnd && userEnd) {
            const endCorrected = correctLocalTime(userEnd, wantedEnd);
            if (endCorrected && endCorrected !== userEnd) {
              ctx.log.info('calendar_add_event: corrected end to match user clock time', {
                from: userEnd,
                to: endCorrected,
                wanted: wantedEnd,
              });
              userEnd = endCorrected;
            }
          }
        }
      }
      a.start = userStart;
      // Default `end` if the model omitted it — a frequent small-model miss.
      // Timed events get a 1-hour block; all-day events get end == start.
      let end = userEnd;
      const allDayInput =
        a.all_day === true || isDateOnly(a.start) || (end !== undefined && isDateOnly(end));
      if (!end) {
        if (allDayInput) {
          end = a.start;
        } else {
          const startDate = new Date(a.start);
          if (Number.isNaN(startDate.getTime())) {
            return `Invalid start: "${a.start}". Pass ISO 8601 with offset, e.g. 2026-05-04T09:00:00-06:00.`;
          }
          startDate.setHours(startDate.getHours() + 1);
          end = startDate.toISOString();
        }
      }
      const allDay = allDayInput || isDateOnly(end);
      const ev = await c.addEvent({
        summary: a.summary,
        start: allDay ? toDateOnly(a.start) : a.start,
        end: allDay ? toDateOnly(end) : end,
        ...(allDay ? { allDay } : {}),
        ...(a.description ? { description: a.description } : {}),
      });
      return `Added: ${formatEventLine(ev)}`;
    },
  });

  host.tools.register({
    name: 'calendar_quick_add',
    intentPattern: CALENDAR_ADD_INTENT,
    description:
      "FALLBACK only. Google's NL parser mangles anything beyond a single-noun event with an explicit clock time on a SPECIFIC named weekday ('Lunch Friday 1pm', 'Gym Saturday 6pm'). " +
      "Skip — use `calendar_add_event` instead — if the phrase has ANY of: 'for/about/with', a duration ('6:30am to 7:30am'), the words 'appointment/session/meeting', the relative-day words 'tomorrow/today/tonight/next/this', a time-of-day word ('morning/afternoon/evening'), or no clock time at all. " +
      'When in doubt: use `calendar_add_event`. quick_add is the wrong default.',
    tier: 'auto',
    selfReplying: true,
    parameters: {
      type: 'object',
      required: ['text'],
      properties: {
        text: {
          type: 'string',
          description:
            "Pass the user's phrase verbatim, including time. Must contain a clock time. Do NOT inject extra words like 'meeting' the user did not say.",
        },
      },
    },
    invoke: async (args, ctx) => {
      const c = getClient(host, ctx.signal);
      if (!c) return NOT_CONFIGURED;
      const text = (args as { text: string }).text;
      if (!hasClockTime(text)) {
        return (
          `"${text}" has no clock time, so Google's quick-add parser will silently drop the date and create the event on TODAY. ` +
          'Switch to `calendar_add_event` with `all_day: true`: resolve the date phrase against the current local date from the system prompt, ' +
          'then pass YYYY-MM-DD for both `start` and `end`.'
        );
      }
      const ev = await c.quickAdd(text);
      return `Added: ${formatEventLine(ev)}`;
    },
  });

  host.tools.register({
    name: 'calendar_delete_event',
    intentPattern: CALENDAR_DELETE_INTENT,
    description:
      "Cancel/delete a calendar event the user named ('cancel the camping event', 'remove tomorrow's 3pm'). " +
      'PREFER `title` (a substring of the event the user named) — the tool will list the upcoming window itself and pick the match, so you do not need to call `calendar_list_events` first. ' +
      'Pass `id` only when you already have one verbatim from a previous `event_ids:` line — never invent or guess an id.',
    tier: 'confirm',
    selfReplying: true,
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description:
            'Google Calendar event id, taken from the trailing `event_ids:` block of a `calendar_list_events` result. Never invent or guess an id.',
        },
        title: {
          type: 'string',
          description:
            "Word or phrase from the event name (e.g. 'camping', 'dentist'). The tool searches the next 30 days and picks the matching event. Use this instead of `id` whenever the user named the event in plain English.",
        },
      },
    },
    invoke: async (args, ctx) => {
      const c = getClient(host, ctx.signal);
      if (!c) return NOT_CONFIGURED;
      const a = args as { id?: string; title?: string };
      const id = a.id?.trim();
      const title = a.title?.trim();
      if (id) {
        await c.deleteEvent(id);
        return 'Deleted.';
      }
      if (!title) {
        return 'Pass `title` (a word from the event name) or `id` to identify which event to delete.';
      }
      const now = new Date();
      const horizon = new Date(now);
      horizon.setDate(horizon.getDate() + 30);
      const events = await c.listEvents({
        timeMin: now.toISOString(),
        timeMax: horizon.toISOString(),
        max: 100,
      });
      const needle = title.toLowerCase();
      const matches = events.filter((ev) => (ev.summary ?? '').toLowerCase().includes(needle));
      if (matches.length === 0) {
        return `No upcoming event matches "${title}" in the next 30 days. Nothing was deleted.`;
      }
      if (matches.length > 1) {
        const list = matches
          .slice(0, 10)
          .map((ev) => `  ${formatEventLine(ev)}`)
          .join('\n');
        return `"${title}" matches multiple upcoming events — be more specific (e.g. include the date):\n${list}`;
      }
      const target = matches[0]!;
      await c.deleteEvent(target.id);
      return `Deleted: ${formatEventLine(target)}`;
    },
  });
}

function isDateOnly(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function toDateOnly(s: string): string {
  if (isDateOnly(s)) return s;
  const d = new Date(s);
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

export interface ClockTime {
  hour: number; // 0–23
  minute: number; // 0–59
}

// Extract explicit am/pm clock times from a user message, in order of
// appearance. "9pm to 10pm" → [{21,0},{22,0}]; "Lunch at 12:30pm" → [{12,30}].
// Exported for tests.
export function extractClockTimes(text: string): ClockTime[] {
  const re = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/gi;
  const out: ClockTime[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = parseInt(m[1]!, 10);
    if (raw < 1 || raw > 12) continue;
    const minute = m[2] ? parseInt(m[2], 10) : 0;
    if (minute > 59) continue;
    const mer = m[3]!.toLowerCase();
    const hour = mer === 'pm' ? (raw % 12) + 12 : raw % 12;
    out.push({ hour, minute });
  }
  return out;
}

// Replace the local-time hour/minute in an ISO string while preserving the
// date and the trailing offset/zone. Returns null when the ISO is not
// parseable. Date-only strings are returned unchanged.
export function correctLocalTime(iso: string, wanted: ClockTime): string | null {
  if (isDateOnly(iso)) return iso;
  const m = iso.match(/^(\d{4}-\d{2}-\d{2}T)(\d{2}):(\d{2})(.*)$/);
  if (!m) return null;
  const curHour = parseInt(m[2]!, 10);
  const curMin = parseInt(m[3]!, 10);
  if (curHour === wanted.hour && curMin === wanted.minute) return iso;
  return `${m[1]}${String(wanted.hour).padStart(2, '0')}:${String(wanted.minute).padStart(2, '0')}${m[4]}`;
}
