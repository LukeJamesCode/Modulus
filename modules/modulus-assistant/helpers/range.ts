// Date-range helpers for briefings and day-planning. Lifted from
// modulus-briefing/gather.ts so gather.ts and tools/planning.ts can share them.

export function dateRangeToday(
  timeZone?: string,
  now: Date = new Date(),
): { timeMin: string; timeMax: string } {
  return dateRangeForOffsetDays(0, timeZone, now);
}

export function dateRangeTomorrow(
  timeZone?: string,
  now: Date = new Date(),
): { timeMin: string; timeMax: string } {
  return dateRangeForOffsetDays(1, timeZone, now);
}

export function dateRangeForOffsetDays(
  offsetDays: number,
  timeZone: string | undefined,
  now: Date,
): { timeMin: string; timeMax: string } {
  if (!timeZone) {
    const start = new Date(now);
    start.setDate(start.getDate() + offsetDays);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return { timeMin: start.toISOString(), timeMax: end.toISOString() };
  }

  const parts = zonedDateParts(now, timeZone);
  const target = addCalendarDays(parts, offsetDays);
  const start = zonedMidnightToInstant(target, timeZone);
  const next = addCalendarDays(target, 1);
  const end = zonedMidnightToInstant(next, timeZone);
  return { timeMin: start.toISOString(), timeMax: end.toISOString() };
}

// Build a range for a specific YYYY-MM-DD date string.
export function dateRangeForDate(
  dateStr: string,
  timeZone?: string,
): { timeMin: string; timeMax: string } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) {
    const now = new Date(dateStr);
    return dateRangeForOffsetDays(0, timeZone, Number.isNaN(now.getTime()) ? new Date() : now);
  }
  const parts: DateParts = {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
  };
  if (!timeZone) {
    const start = new Date(parts.year, parts.month - 1, parts.day, 0, 0, 0, 0);
    const end = new Date(parts.year, parts.month - 1, parts.day + 1, 0, 0, 0, 0);
    return { timeMin: start.toISOString(), timeMax: end.toISOString() };
  }
  const start = zonedMidnightToInstant(parts, timeZone);
  const end = zonedMidnightToInstant(addCalendarDays(parts, 1), timeZone);
  return { timeMin: start.toISOString(), timeMax: end.toISOString() };
}

interface DateParts {
  year: number;
  month: number;
  day: number;
}

export function zonedDateParts(date: Date, timeZone: string): DateParts {
  const parts = new Intl.DateTimeFormat('en-US-u-ca-gregory', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  return { year: Number(get('year')), month: Number(get('month')), day: Number(get('day')) };
}

export function addCalendarDays(parts: DateParts, days: number): DateParts {
  const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 12));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

export function zonedMidnightToInstant(parts: DateParts, timeZone: string): Date {
  let utc = Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0, 0);
  for (let i = 0; i < 3; i++) {
    utc =
      Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0, 0) -
      offsetMs(new Date(utc), timeZone);
  }
  return new Date(utc);
}

export function offsetMs(date: Date, timeZone: string): number {
  const name = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'shortOffset',
  })
    .formatToParts(date)
    .find((p) => p.type === 'timeZoneName')?.value;
  const m = /^GMT(?:(?<sign>[+-])(?<hour>\d{1,2})(?::(?<minute>\d{2}))?)?$/.exec(name ?? '');
  if (!m) throw new Error(`unable to determine timezone offset for ${timeZone}`);
  const sign = m.groups?.sign === '-' ? -1 : 1;
  const hour = Number(m.groups?.hour ?? 0);
  const minute = Number(m.groups?.minute ?? 0);
  return sign * (hour * 60 + minute) * 60_000;
}
