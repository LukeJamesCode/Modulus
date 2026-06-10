// Day-planning tools: plan_day, find_free_slot, smart_schedule_task,
// weather_reschedule_check. These synthesise calendar + tasks + weather
// to give actionable scheduling advice.

import type { Host } from '../../../src/core/modules.js';
import type { Nudge } from '../../../src/core/scheduler.js';
import { getClient as getCalClient, formatEventLine } from '../helpers/calendar.js';
import { getClient as getTasksClient, findTaskByTitle, formatTask } from '../helpers/tasks.js';
import { geocode, fetchWeatherReport } from '../api/weather.js';
import { dateRangeForOffsetDays, dateRangeForDate } from '../helpers/range.js';

const PLAN_INTENT =
  '\\b(plan my day|day plan|what.*day look like|day overview|block out (tomorrow|today|my day|the day))\\b';
const FREE_SLOT_INTENT =
  '\\b(free time|free slot|available|when am i free|find.*free|open slot)\\b';
const SCHEDULE_TASK_INTENT =
  '\\b(block out (time|an hour|a few hours|\\d+\\s*(min|minutes?|hours?))' +
  '|schedule.*task|put.*task.*calendar|place.*task.*calendar' +
  '|(schedule|fit in|find time for)\\b.*\\b(report|project|work|study|chore|errand|task)' +
  '|(schedule|fit in|put|place)\\b.*\\b(\\d+\\s*(min|minutes?|hours?))\\b.*\\b(this week|next week|tomorrow|today|somewhere|mornings?|afternoons?|evenings?))\\b';
const WEATHER_RESCHEDULE_INTENT =
  '\\b(weather.*(affect|plans|reschedule)|reschedule.*weather|outdoor.*weather' +
  '|outdoor.*(rain|snow|storm)|(rain|snow|storm).*outdoor|rained on|get wet' +
  '|will.*rain.*event|will.*weather.*event|going to get rained)\\b';

// Outdoor-activity heuristic: match common outdoor activities in event title/description.
const OUTDOOR_REGEX =
  /\b(run|jog|walk|hike|bike|cycling|picnic|park|outdoor|garden|yard|patio|beach|tennis|golf|soccer|football|baseball|ski|snowshoe|kayak|hiking|swim|swimming|surfing|fishing|camping|trail)\b/i;

// WMO condition codes considered "bad" for outdoor events.
const BAD_WEATHER_CODES = new Set([61, 63, 65, 71, 73, 75, 80, 81, 82, 85, 86, 95, 96, 99]);

export function register(host: Host): void {
  host.tools.register({
    name: 'plan_day',
    intentPattern: PLAN_INTENT,
    description:
      "Synthesise calendar + due tasks + weather into a day plan. Use for 'plan my day / what does my day look like / block out my day or tomorrow / day overview'.",
    tier: 'auto',
    parameters: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description: 'YYYY-MM-DD date to plan. Omit to default to today.',
        },
        include_weather: {
          type: 'boolean',
          description: 'Include weather in the plan. Default true.',
        },
      },
    },
    invoke: async (args, ctx) => {
      const a = args as { date?: string; include_weather?: boolean };
      const timeZone = host.settings.get<string>('time_zone') || undefined;
      const dateStr = a.date?.trim() || todayIso();
      const range = dateRangeForDate(dateStr, timeZone);
      const withWeather = a.include_weather !== false;

      const parts: string[] = [`📅 Day plan for ${dateStr}`];

      // Weather
      if (withWeather) {
        const loc = host.settings.get<string>('default_location');
        if (loc) {
          try {
            const geo = await geocode(loc, { signal: ctx.signal });
            if (geo) {
              const report = await fetchWeatherReport(geo.lat, geo.lon, { signal: ctx.signal });
              const c = report.current;
              parts.push(
                `Weather (${geo.name}): ${c.condition} · ${c.tempC}°C (feels ${c.feelsLikeC}°C) · Wind ${c.windKph} km/h`,
              );
            }
          } catch {
            // weather failure is non-fatal
          }
        }
      }

      // Calendar events
      const cal = getCalClient(host, ctx.signal);
      if (cal) {
        try {
          const events = await cal.listEvents({ ...range, max: 25 });
          if (events.length > 0) {
            parts.push('📆 Events:\n' + events.map((ev) => '  ' + formatEventLine(ev)).join('\n'));
          } else {
            parts.push('📆 Events: none scheduled.');
          }
        } catch {
          parts.push('📆 Events: (unavailable)');
        }
      } else {
        parts.push('📆 Events: Google Calendar not configured.');
      }

      // Due tasks
      const tasks = getTasksClient(host, ctx.signal);
      if (tasks) {
        try {
          const allTasks = await tasks.listTasks(false);
          const dueToday = allTasks.filter((t) => {
            if (!t.due) return false;
            const dueDate = t.due.slice(0, 10);
            return dueDate <= dateStr;
          });
          if (dueToday.length > 0) {
            parts.push(
              '✅ Due tasks:\n' +
                dueToday
                  .slice(0, 10)
                  .map((t) => '  ' + formatTask(t))
                  .join('\n'),
            );
          } else {
            parts.push('✅ Due tasks: none due today.');
          }
        } catch {
          parts.push('✅ Due tasks: (unavailable)');
        }
      } else {
        parts.push('✅ Due tasks: Google Tasks not configured.');
      }

      return parts.join('\n\n');
    },
  });

  host.tools.register({
    name: 'find_free_slot',
    intentPattern: FREE_SLOT_INTENT,
    description:
      "Find free time slots in the calendar. Use for 'when am I free / find me a free hour / what time slots do I have'. Returns the N largest free gaps within bounds.",
    tier: 'auto',
    parameters: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description: 'YYYY-MM-DD date to search. Omit to default to today.',
        },
        duration_minutes: {
          type: 'number',
          minimum: 30,
          description: 'Minimum slot duration in minutes. Must be >= 30. Default 30.',
        },
        earliest: {
          type: 'string',
          description: 'Earliest start time (HH:MM 24h). Default "09:00".',
        },
        latest: {
          type: 'string',
          description: 'Latest end time (HH:MM 24h). Default "21:00".',
        },
        count: {
          type: 'number',
          description: 'Max number of slots to return. Default 3.',
        },
      },
    },
    invoke: async (args, ctx) => {
      const a = args as {
        date?: string;
        duration_minutes?: number;
        earliest?: string;
        latest?: string;
        count?: number;
      };
      return findFreeSlots(host, a, ctx.signal);
    },
  });

  host.tools.register({
    name: 'smart_schedule_task',
    intentPattern: SCHEDULE_TASK_INTENT,
    description:
      'Place an EXISTING Google Task on the calendar in a free slot. ' +
      "Use only when the user explicitly asks to fit/schedule/block out time for a NAMED task they already have ('schedule the project report for 2 hours this week, mornings preferred'). " +
      "Fails if no matching task exists. Not for new event creation or generic 'plan my day'.",
    tier: 'auto',
    selfReplying: true,
    parameters: {
      type: 'object',
      properties: {
        task_title: {
          type: 'string',
          description: 'Task title or unique substring to schedule.',
        },
        task_id: {
          type: 'string',
          description: 'Task id from tasks_list. Use when title is ambiguous.',
        },
        duration_minutes: {
          type: 'number',
          description: 'Duration to block in minutes. Default 30.',
        },
        date: {
          type: 'string',
          description: 'YYYY-MM-DD date for the slot. Omit to default to today.',
        },
        earliest: { type: 'string', description: 'Earliest start time (HH:MM). Default "09:00".' },
        latest: { type: 'string', description: 'Latest end time (HH:MM). Default "21:00".' },
      },
    },
    invoke: async (args, ctx) => {
      const a = args as {
        task_title?: string;
        task_id?: string;
        duration_minutes?: number;
        date?: string;
        earliest?: string;
        latest?: string;
      };

      const cal = getCalClient(host, ctx.signal);
      const tasks = getTasksClient(host, ctx.signal);
      if (!cal) return 'Google Calendar is not configured. Run `modulus auth modulus-assistant`.';
      if (!tasks) return 'Google Tasks is not configured. Run `modulus auth modulus-assistant`.';

      // Resolve task
      let taskId: string;
      let taskTitle: string;
      if (a.task_id?.trim()) {
        taskId = a.task_id.trim();
        taskTitle = a.task_title?.trim() || taskId;
      } else if (a.task_title?.trim()) {
        const match = await findTaskByTitle(tasks, a.task_title, undefined, false);
        if (match.kind === 'none')
          return (
            `No Google Task title contains "${a.task_title}". ` +
            `Tell the user that task isn't on their list yet, or offer to create it with tasks_add first.`
          );
        if (match.kind === 'many') {
          return (
            `"${a.task_title}" matches multiple tasks — be more specific:\n` +
            match.matches.map((t) => `• ${t.title}`).join('\n')
          );
        }
        taskId = match.task.id;
        taskTitle = match.task.title;
      } else {
        return 'Pass task_title or task_id to identify the task to schedule.';
      }

      // Find a free slot
      const duration = Math.max(30, a.duration_minutes ?? 30);
      const slotResult = await findFreeSlotsInternal(
        host,
        {
          date: a.date,
          duration_minutes: duration,
          earliest: a.earliest,
          latest: a.latest,
          count: 1,
        },
        ctx.signal,
      );

      if (slotResult.slots.length === 0) {
        return `No free ${duration}-minute slot found on ${a.date ?? todayIso()}. Try a different date or shorter duration.`;
      }

      const slot = slotResult.slots[0]!;
      const ev = await cal.addEvent({
        summary: taskTitle,
        start: slot.startIso,
        end: slot.endIso,
        description: `Auto-scheduled from Google Tasks (task_id=${taskId})`,
      });

      // Record the link so a future hook can clean up the calendar event on completion.
      host.db
        .prepare(
          `INSERT OR IGNORE INTO smart_scheduled_links (task_id, event_id, scheduled_at) VALUES (?, ?, ?)`,
        )
        .run(taskId, ev.id, Date.now());

      return (
        `Scheduled "${taskTitle}" for ${slot.label}.\n` +
        `Mark it done with /done or tasks_complete when finished.\n` +
        `event_id: ${ev.id}`
      );
    },
  });

  host.tools.register({
    name: 'weather_reschedule_check',
    intentPattern: WEATHER_RESCHEDULE_INTENT,
    description:
      "Cross-reference outdoor calendar events with the forecast and flag any at risk of bad weather. Use for 'will the weather affect my plans / anything outdoor going to get rained on'.",
    tier: 'auto',
    parameters: { type: 'object', properties: {} },
    invoke: async (_args, ctx) => {
      const result = await weatherRescheduleCheck(host, ctx.signal);
      if (result.length === 0)
        return 'No outdoor events flagged — your upcoming plans look weather-safe.';
      return result.join('\n\n');
    },
  });
}

// Exported for use in jobs.ts cron. Each flagged event becomes a reschedule
// proposal (open or reused) plus a Yes/No nudge driven by the reschedule
// callback handlers.
export async function weatherRescheduleCheckNudges(host: Host): Promise<Nudge[]> {
  const chatIds = targetChatIds(host);
  if (chatIds.length === 0) return [];
  const flags = await weatherRescheduleScan(host);
  if (flags.length === 0) return [];

  // Lazy import: tools/reschedule.ts depends on this file (planning.ts) via
  // findFreeSlotsInternal, so a static import would create a circular module.
  const { openProposal } = await import('./reschedule.js');

  const nudges: Nudge[] = [];
  for (const chatId of chatIds) {
    for (const flag of flags) {
      const opened = openProposal(host.db, {
        chatId,
        eventId: flag.eventId,
        eventSummary: flag.eventSummary,
        eventStart: flag.eventStart,
        eventEnd: flag.eventEnd,
        reason: flag.reasonText,
      });
      if (opened) nudges.push(opened.nudge);
    }
  }
  return nudges;
}

interface WeatherFlag {
  eventId: string;
  eventSummary: string;
  eventStart: string;
  eventEnd: string;
  reasonText: string;
}

async function weatherRescheduleCheck(host: Host, signal?: AbortSignal): Promise<string[]> {
  const flags = await weatherRescheduleScan(host, signal);
  return flags.map((f) => {
    const timeStr = f.eventStart.slice(11, 16);
    const date = f.eventStart.slice(0, 10);
    return `⚠️ Weather alert for outdoor event "${f.eventSummary}" at ${timeStr} on ${date}: ${f.reasonText}`;
  });
}

async function weatherRescheduleScan(host: Host, signal?: AbortSignal): Promise<WeatherFlag[]> {
  const cal = getCalClient(host, signal);
  if (!cal) return [];

  const loc = host.settings.get<string>('default_location');
  if (!loc) return [];

  const timeZone = host.settings.get<string>('time_zone') || undefined;
  const todayRange = dateRangeForOffsetDays(0, timeZone, new Date());
  const tomorrowRange = dateRangeForOffsetDays(1, timeZone, new Date());

  let events: Awaited<ReturnType<typeof cal.listEvents>>;
  try {
    events = await cal.listEvents({
      timeMin: todayRange.timeMin,
      timeMax: tomorrowRange.timeMax,
      max: 50,
    });
  } catch {
    return [];
  }

  const outdoorEvents = events.filter(
    (ev) =>
      !ev.allDay &&
      (OUTDOOR_REGEX.test(ev.summary) ||
        (typeof (ev as { description?: string }).description === 'string' &&
          OUTDOOR_REGEX.test((ev as { description?: string }).description!))),
  );

  if (outdoorEvents.length === 0) return [];

  let geo: Awaited<ReturnType<typeof geocode>>;
  let forecastDays: Awaited<ReturnType<typeof fetchWeatherReport>>['forecast'];
  try {
    geo = await geocode(loc, { signal });
    if (!geo) return [];
    const report = await fetchWeatherReport(geo.lat, geo.lon, { signal });
    forecastDays = report.forecast;
  } catch {
    return [];
  }

  const flags: WeatherFlag[] = [];
  for (const ev of outdoorEvents) {
    const evDate = ev.start.slice(0, 10);
    const dayForecast = forecastDays.find((d) => d.date === evDate);
    if (!dayForecast) continue;
    const isBad =
      dayForecast.precipPct >= 60 || BAD_WEATHER_CODES.has(dayForecast.conditionCode) || false;
    if (isBad) {
      flags.push({
        eventId: ev.id,
        eventSummary: ev.summary,
        eventStart: ev.start,
        eventEnd: ev.end,
        reasonText: `${dayForecast.condition}, ${dayForecast.precipPct}% precip.`,
      });
    }
  }
  return flags;
}

// Exported for smart_schedule_task and find_free_slot tool.
export interface FreeSlot {
  startIso: string;
  endIso: string;
  label: string;
}

interface FindFreeSlotsArgs {
  date?: string;
  duration_minutes?: number;
  earliest?: string;
  latest?: string;
  count?: number;
}

interface FindFreeSlotsResult {
  slots: FreeSlot[];
  warning?: string;
}

export async function findFreeSlotsInternal(
  host: Host,
  args: FindFreeSlotsArgs,
  signal?: AbortSignal,
): Promise<FindFreeSlotsResult> {
  const cal = getCalClient(host, signal);
  if (!cal) return { slots: [], warning: 'Google Calendar not configured.' };

  const timeZone = host.settings.get<string>('time_zone') || undefined;
  const dateStr = args.date?.trim() || todayIso();
  const duration = Math.max(30, args.duration_minutes ?? 30);
  const count = args.count ?? 3;

  const earliestParts = parseHHMM(args.earliest ?? '09:00');
  const latestParts = parseHHMM(args.latest ?? '21:00');
  if (!earliestParts) {
    return { slots: [], warning: `Invalid earliest time "${args.earliest}". Use HH:MM.` };
  }
  if (!latestParts) {
    return { slots: [], warning: `Invalid latest time "${args.latest}". Use HH:MM.` };
  }
  const [ehH, ehM] = earliestParts;
  const [lhH, lhM] = latestParts;

  // Build boundary instants for the target date.
  const dayRange = dateRangeForDate(dateStr, timeZone);
  const dayStart = new Date(dayRange.timeMin);
  const earliest = new Date(dayStart);
  earliest.setHours(ehH, ehM, 0, 0);
  const latest = new Date(dayStart);
  latest.setHours(lhH, lhM, 0, 0);
  if (latest <= earliest) {
    return { slots: [], warning: 'latest must be after earliest.' };
  }

  let events: Awaited<ReturnType<typeof cal.listEvents>>;
  try {
    events = await cal.listEvents({
      timeMin: dayRange.timeMin,
      timeMax: dayRange.timeMax,
      max: 50,
    });
  } catch {
    return { slots: [], warning: 'Could not fetch calendar events.' };
  }

  // Only timed events block slots; all-day events don't occupy intra-day time.
  const allDayPresent = events.some((ev) => ev.allDay);
  const timedEvents = events
    .filter((ev) => !ev.allDay)
    .map((ev) => ({ start: new Date(ev.start), end: new Date(ev.end) }))
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  const slots: FreeSlot[] = [];

  // Walk gaps: [earliest, first_event), between events, [last_event_end, latest)
  const boundaries: Array<{ from: Date; to: Date }> = [];
  let cursor = new Date(earliest);
  for (const ev of timedEvents) {
    const evStart = ev.start < earliest ? earliest : ev.start;
    if (evStart > cursor) boundaries.push({ from: cursor, to: evStart });
    cursor = ev.end > cursor ? ev.end : cursor;
  }
  if (cursor < latest) boundaries.push({ from: cursor, to: latest });

  for (const gap of boundaries) {
    const gapMs = gap.to.getTime() - gap.from.getTime();
    if (gapMs >= duration * 60_000) {
      const end = new Date(gap.from.getTime() + duration * 60_000);
      slots.push({
        startIso: gap.from.toISOString(),
        endIso: end.toISOString(),
        label: `${fmtLocalTime(gap.from)} – ${fmtLocalTime(end)} on ${dateStr}`,
      });
      if (slots.length >= count) break;
    }
  }

  return {
    slots,
    ...(allDayPresent ? { warning: 'All-day events present but not counted as blockers.' } : {}),
  };
}

async function findFreeSlots(
  host: Host,
  args: FindFreeSlotsArgs,
  signal?: AbortSignal,
): Promise<string> {
  const { slots, warning } = await findFreeSlotsInternal(host, args, signal);
  const dur = Math.max(30, args.duration_minutes ?? 30);
  const date = args.date?.trim() || todayIso();
  if (slots.length === 0) {
    const msg = `No free ${dur}-minute slots found on ${date} between ${args.earliest ?? '09:00'} and ${args.latest ?? '21:00'}.`;
    return warning ? `${msg}\n(${warning})` : msg;
  }
  const lines = slots.map((s, i) => `${i + 1}. ${s.label} (${dur} min)`).join('\n');
  return `Free ${dur}-minute slots on ${date}:\n${lines}${warning ? `\n\nNote: ${warning}` : ''}`;
}

function todayIso(): string {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

function parseHHMM(hhmm: string): [number, number] | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return [hour, minute];
}

function fmtLocalTime(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function targetChatIds(host: Host): number[] {
  const configured = Number(host.settings.get<number | string>('briefing_chat_id', 0));
  if (Number.isFinite(configured) && configured !== 0) return [configured];
  const configured2 = Number(host.settings.get<number | string>('nudge_chat_id', 0));
  if (Number.isFinite(configured2) && configured2 !== 0) return [configured2];
  return host.telegram.defaultChatId ? [host.telegram.defaultChatId] : [];
}
