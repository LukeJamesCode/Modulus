// Data-gathering helpers for briefings and day-planning. Reads all credentials
// from this module's unified settings (google_* keys) so there is no
// cross-module DB reading.

import type { Host } from '../../src/core/modules.js';
import { geocode, fetchWeatherReport, formatReport } from './api/weather.js';
import { formatEventLine, getClient as getCalClient } from './helpers/calendar.js';
import { formatTask, getClient as getTasksClient } from './helpers/tasks.js';
import { dateRangeToday, dateRangeTomorrow } from './helpers/range.js';

interface GatherOptions {
  signal?: AbortSignal;
}

export async function gatherWeather(
  host: Host,
  location?: string,
  opts: GatherOptions = {},
): Promise<string | null> {
  const loc = location ?? host.settings.get<string>('default_location');
  if (!loc) return null;
  try {
    const geo = await geocode(loc, opts);
    if (!geo) return null;
    const report = await fetchWeatherReport(geo.lat, geo.lon, opts);
    report.locationName = geo.name;
    return `Weather (${geo.name}):\n${formatReport(report)}`;
  } catch {
    return null;
  }
}

export async function gatherCalendar(
  host: Host,
  range: { timeMin: string; timeMax: string },
  opts: { timeZone?: string; signal?: AbortSignal } = {},
): Promise<string | null> {
  const c = getCalClient(host, opts.signal);
  if (!c) return null;
  try {
    const events = await c.listEvents(range);
    if (events.length === 0) return 'Calendar: no events.';
    return 'Calendar:\n' + events.map((ev) => formatEventLine(ev, opts)).join('\n');
  } catch {
    return null;
  }
}

export async function gatherTasks(host: Host, opts: GatherOptions = {}): Promise<string | null> {
  const c = getTasksClient(host, opts.signal);
  if (!c) return null;
  try {
    const tasks = await c.listTasks(false);
    if (tasks.length === 0) return 'Tasks: none.';
    return (
      'Tasks:\n' +
      tasks
        .slice(0, 10)
        .map((t) => formatTask(t))
        .join('\n')
    );
  } catch {
    return null;
  }
}

export function briefingTimeZone(host: Host): string | undefined {
  const tz = host.settings.get<string>('time_zone')?.trim();
  return tz || undefined;
}

function pushFulfilled(parts: string[], results: Array<PromiseSettledResult<string | null>>): void {
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) parts.push(result.value);
  }
}

// If every child gather rejected, the user otherwise sees just the header and
// has no idea their integrations are down. Surface a single warning so a
// broken Google or Open-Meteo run is visible without spamming details.
function appendAllFailedNotice(
  parts: string[],
  results: Array<PromiseSettledResult<string | null>>,
): void {
  if (results.length === 0) return;
  const anyFulfilled = results.some((r) => r.status === 'fulfilled' && r.value);
  if (anyFulfilled) return;
  const anyRejected = results.some((r) => r.status === 'rejected');
  if (anyRejected) {
    parts.push('⚠️ Could not reach your calendar / tasks / weather sources this run.');
  }
}

export async function buildMorningBrief(host: Host, opts: GatherOptions = {}): Promise<string> {
  const timeZone = briefingTimeZone(host);
  const today = new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    ...(timeZone ? { timeZone } : {}),
  });
  const parts: string[] = [`🌅 Good morning! ${today}`];

  const gathers: Array<Promise<string | null>> = [];
  if (host.settings.get<boolean>('include_weather', true)) {
    gathers.push(gatherWeather(host, undefined, opts));
  }
  if (host.settings.get<boolean>('include_calendar', true)) {
    gathers.push(gatherCalendar(host, dateRangeToday(timeZone), { timeZone, signal: opts.signal }));
  }
  if (host.settings.get<boolean>('include_tasks', true)) {
    gathers.push(gatherTasks(host, opts));
  }
  const results = await Promise.allSettled(gathers);
  pushFulfilled(parts, results);
  appendAllFailedNotice(parts, results);

  return parts.join('\n\n');
}

export async function buildNightBrief(host: Host, opts: GatherOptions = {}): Promise<string> {
  const timeZone = briefingTimeZone(host);
  const parts: string[] = ['🌙 Evening summary'];

  const gathers: Array<Promise<string | null>> = [];
  if (host.settings.get<boolean>('include_calendar', true)) {
    gathers.push(
      gatherCalendar(host, dateRangeTomorrow(timeZone), { timeZone, signal: opts.signal }).then(
        (tomorrowCal) =>
          tomorrowCal ? "Tomorrow's calendar:\n" + tomorrowCal.replace('Calendar:\n', '') : null,
      ),
    );
  }
  if (host.settings.get<boolean>('include_tasks', true)) {
    gathers.push(gatherTasks(host, opts));
  }
  const results = await Promise.allSettled(gathers);
  pushFulfilled(parts, results);
  appendAllFailedNotice(parts, results);

  return parts.join('\n\n');
}

export function rememberBriefingChat(host: Host, chatId: number): void {
  host.settings.set('briefing_chat_id', chatId);
}
