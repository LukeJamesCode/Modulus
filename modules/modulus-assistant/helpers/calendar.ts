// Calendar helpers: credential loading, client factory, and formatting.
// getCredentials reads the unified google_* keys (merged from the old
// modulus-google-calendar client_id/client_secret/refresh_token keys).

import type { Host } from '../../../src/core/modules.js';
import {
  createCalendarClient,
  type CalendarAccessTokenCache,
  type CalendarClient,
  type CalendarCredentials,
} from '../api/calendar.js';
import { readGoogleOAuth } from './google-creds.js';

// One in-memory token cache per host instance, captured by closure on first
// access. Separate WeakMap from helpers/tasks.ts so the two token caches
// never clobber each other.
const tokenCaches = new WeakMap<Host, { current: CalendarAccessTokenCache | null }>();

export function getCredentials(host: Host): CalendarCredentials | null {
  const base = readGoogleOAuth(host);
  if (!base) return null;
  return { ...base, calendar_id: host.settings.get<string>('calendar_id', 'primary')! };
}

export function getClient(host: Host, signal?: AbortSignal): CalendarClient | null {
  const creds = getCredentials(host);
  if (!creds) return null;
  let cache = tokenCaches.get(host);
  if (!cache) {
    cache = { current: null };
    tokenCaches.set(host, cache);
  }
  return createCalendarClient({ creds, cache, ...(signal ? { signal } : {}) });
}

export function todayRangeIso(
  now: Date = new Date(),
  timeZone?: string,
): { timeMin: string; timeMax: string } {
  if (!timeZone) {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return { timeMin: start.toISOString(), timeMax: end.toISOString() };
  }
  const start = startOfDayInZone(now, timeZone);
  const end = new Date(start.getTime());
  // Re-anchor in the target zone so we cross exactly one local midnight,
  // not exactly 24h (which would be wrong on DST days).
  const startParts = zonedYmd(start, timeZone);
  end.setTime(
    instantForZonedWallClock(
      { ...startParts, day: startParts.day + 1, hour: 0, minute: 0, second: 0 },
      timeZone,
    ).getTime(),
  );
  return { timeMin: start.toISOString(), timeMax: end.toISOString() };
}

interface YmdHms {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function zonedYmd(d: Date, timeZone: string): YmdHms {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const o: Record<string, string> = {};
  for (const p of parts) if (p.type !== 'literal') o[p.type] = p.value;
  return {
    year: Number(o.year),
    month: Number(o.month),
    day: Number(o.day),
    hour: o.hour === '24' ? 0 : Number(o.hour),
    minute: Number(o.minute),
    second: Number(o.second),
  };
}

// Resolve a wall-clock time in a target zone to a UTC instant. Iterates twice
// to settle DST near the hour-of-change; sufficient for any IANA zone.
function instantForZonedWallClock(wall: YmdHms, timeZone: string): Date {
  const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  let guess = new Date(naive);
  for (let i = 0; i < 2; i++) {
    const got = zonedYmd(guess, timeZone);
    const gotUtc = Date.UTC(got.year, got.month - 1, got.day, got.hour, got.minute, got.second);
    guess = new Date(guess.getTime() + (naive - gotUtc));
  }
  return guess;
}

function startOfDayInZone(now: Date, timeZone: string): Date {
  const { year, month, day } = zonedYmd(now, timeZone);
  return instantForZonedWallClock({ year, month, day, hour: 0, minute: 0, second: 0 }, timeZone);
}

// `calendar_quick_add` forwards the user's phrase to Google's natural-language
// parser. If the phrase has no clock time, Google sometimes silently drops the
// date and creates the event on TODAY. We use this as a pre-flight check so
// the tool can refuse and steer the model to `calendar_add_event` with
// `all_day: true` instead.
export function hasClockTime(text: string): boolean {
  const s = text.toLowerCase();
  // 1pm, 10:30am, 9-10am, 09:00
  if (/\b\d{1,2}(:\d{2})?\s*(am|pm)\b/.test(s)) return true;
  if (/\b\d{1,2}:\d{2}\b/.test(s)) return true;
  // "at 3", "at 9pm" (am|pm caught above; this covers bare "at 3")
  if (/\bat\s+\d{1,2}\b/.test(s)) return true;
  // Common idiomatic time-of-day words.
  if (/\b(noon|midnight|morning|afternoon|evening|night|tonight)\b/.test(s)) return true;
  return false;
}

export function formatEventLine(
  ev: {
    summary: string;
    start: string;
    end: string;
    id: string;
    allDay?: boolean;
    startTimeZone?: string;
    endTimeZone?: string;
  },
  opts: { timeZone?: string } = {},
): string {
  // Always include the start date so the model can anchor each line.
  if (ev.allDay || (isDateOnly(ev.start) && isDateOnly(ev.end))) {
    const start = parseLocalDateOnly(ev.start);
    const inclusiveEnd = parseLocalDateOnly(ev.end);
    inclusiveEnd.setDate(inclusiveEnd.getDate() - 1);
    const end = inclusiveEnd < start ? start : inclusiveEnd;
    const dateText = sameLocalDay(start, end)
      ? fmtDate(start)
      : `${fmtDate(start)}–${fmtDate(end)}`;
    return `${dateText}  All day  ${ev.summary}`;
  }

  const s = parseZonedDateTime(ev.start);
  const e = parseZonedDateTime(ev.end);
  const tz = opts.timeZone ?? ev.startTimeZone;
  if (!tz && s && e) {
    return `${fmtDateParts(s)}  ${fmtTimeParts(s)}–${fmtTimeParts(e)}  ${ev.summary}`;
  }

  const start = new Date(ev.start);
  const end = new Date(ev.end);
  return `${fmtDate(start, tz)}  ${fmtTime(start, tz)}–${fmtTime(end, opts.timeZone ?? ev.endTimeZone ?? tz)}  ${ev.summary}`;
}

function fmtTime(d: Date, timeZone?: string): string {
  return d.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  });
}

function fmtDate(d: Date, timeZone?: string): string {
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(timeZone ? { timeZone } : {}),
  });
}

function isDateOnly(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function parseLocalDateOnly(s: string): Date {
  const [, y, m, d] = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s) ?? [];
  return new Date(Number(y), Number(m) - 1, Number(d));
}

function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

interface ZonedDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function parseZonedDateTime(s: string): ZonedDateTimeParts | null {
  const m =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})$/.exec(
      s,
    );
  if (!m) return null;
  return {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4]),
    minute: Number(m[5]),
  };
}

function fmtTimeParts(parts: ZonedDateTimeParts): string {
  const period = parts.hour >= 12 ? 'PM' : 'AM';
  const hour12 = parts.hour % 12 || 12;
  return `${String(hour12).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')} ${period}`;
}

function fmtDateParts(parts: ZonedDateTimeParts): string {
  const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12, 0, 0));
  return d.toLocaleDateString(undefined, {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}
