// Minimal 5-field cron parser. Supports the subset modules actually need
// for nudges and sweeps: `*`, `*/N`, `N`, `N-M`, `N,M,P`. No `@daily` aliases,
// no seconds field. Day-of-week 0-6 with 0 = Sunday.
//
// We roll our own instead of pulling node-cron because (a) the parsing surface
// is tiny, (b) we want next-fire computation that matches our tick model
// exactly without touching `setInterval`, and (c) shipping zero extra
// dependencies keeps install size on a Pi small.

export interface ParsedCron {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
}

const RANGES: Array<[keyof ParsedCron, number, number]> = [
  ['minute', 0, 59],
  ['hour', 0, 23],
  ['dayOfMonth', 1, 31],
  ['month', 1, 12],
  ['dayOfWeek', 0, 6],
];

export function parseCron(expr: string): ParsedCron {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`cron expression must have 5 fields, got ${fields.length}: '${expr}'`);
  }
  const out: Partial<ParsedCron> = {};
  for (let i = 0; i < RANGES.length; i++) {
    const [key, lo, hi] = RANGES[i]!;
    out[key] = parseField(fields[i]!, lo, hi);
  }
  return out as ParsedCron;
}

function parseField(field: string, lo: number, hi: number): Set<number> {
  const set = new Set<number>();
  for (const part of field.split(',')) {
    let step = 1;
    let body = part;
    const slash = part.indexOf('/');
    if (slash !== -1) {
      step = Number.parseInt(part.slice(slash + 1), 10);
      body = part.slice(0, slash);
      if (!Number.isFinite(step) || step <= 0) {
        throw new Error(`invalid cron step '${part}'`);
      }
    }
    let start: number;
    let end: number;
    if (body === '*') {
      start = lo;
      end = hi;
    } else if (body.includes('-')) {
      const [a, b] = body.split('-');
      start = Number.parseInt(a!, 10);
      end = Number.parseInt(b!, 10);
    } else {
      // A bare `N/step` (e.g. `5/15`) is ambiguous: standard cron reads it as
      // `N-max/step`, but this parser would collapse it to the single value N
      // and silently drop the step. Reject it rather than misinterpret. Use
      // `N-M/step` or `*/step` to express stepping explicitly.
      if (slash !== -1) {
        throw new Error(
          `invalid cron field '${part}': bare 'N/step' is unsupported — use 'N-M/step' or '*/step'`,
        );
      }
      start = end = Number.parseInt(body, 10);
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < lo || end > hi || start > end) {
      throw new Error(`invalid cron field '${part}' for range ${lo}-${hi}`);
    }
    for (let v = start; v <= end; v += step) set.add(v);
  }
  return set;
}

export interface CronDateParts {
  minute: number;
  hour: number;
  dayOfMonth: number;
  month: number;
  dayOfWeek: number;
}

// Returns true if `date` matches the cron expression at minute granularity.
// By default this uses the process local timezone. Passing an IANA timezone
// lets an module schedule user-facing jobs by the user/calendar timezone
// even when Modulus itself runs in a UTC container.
export function matchesCron(parsed: ParsedCron, date: Date, timeZone?: string): boolean {
  const parts = timeZone ? datePartsInTimeZone(date, timeZone) : localDateParts(date);
  return matchesCronParts(parsed, parts);
}

export function matchesCronParts(parsed: ParsedCron, parts: CronDateParts): boolean {
  return (
    parsed.minute.has(parts.minute) &&
    parsed.hour.has(parts.hour) &&
    parsed.dayOfMonth.has(parts.dayOfMonth) &&
    parsed.month.has(parts.month) &&
    parsed.dayOfWeek.has(parts.dayOfWeek)
  );
}

function localDateParts(date: Date): CronDateParts {
  return {
    minute: date.getMinutes(),
    hour: date.getHours(),
    dayOfMonth: date.getDate(),
    month: date.getMonth() + 1,
    dayOfWeek: date.getDay(),
  };
}

export function datePartsInTimeZone(date: Date, timeZone: string): CronDateParts {
  const parts = new Intl.DateTimeFormat('en-US-u-ca-gregory', {
    timeZone,
    hourCycle: 'h23',
    minute: '2-digit',
    hour: '2-digit',
    day: '2-digit',
    month: '2-digit',
    weekday: 'short',
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  return {
    minute: Number(get('minute')),
    hour: Number(get('hour')),
    dayOfMonth: Number(get('day')),
    month: Number(get('month')),
    dayOfWeek: weekdayIndex(get('weekday')),
  };
}

function weekdayIndex(shortWeekday: string): number {
  switch (shortWeekday) {
    case 'Sun':
      return 0;
    case 'Mon':
      return 1;
    case 'Tue':
      return 2;
    case 'Wed':
      return 3;
    case 'Thu':
      return 4;
    case 'Fri':
      return 5;
    case 'Sat':
      return 6;
    default:
      throw new Error(`unexpected weekday from Intl: ${shortWeekday}`);
  }
}

// Compute the next minute >= `from` (rounded up to next whole minute) that
// matches the expression. Bounded search — gives up after 4 years and throws
// rather than spinning forever on a malformed cron. Pass `timeZone` (IANA) to
// match in that zone instead of process-local time, mirroring `matchesCron`;
// without it a tz-scheduled job would compute its next fire in the wrong zone.
export function nextFireAfter(parsed: ParsedCron, from: Date, timeZone?: string): Date {
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = new Date(d.getTime());
  limit.setFullYear(limit.getFullYear() + 4);
  while (d <= limit) {
    if (matchesCron(parsed, d, timeZone)) return d;
    d.setMinutes(d.getMinutes() + 1);
  }
  throw new Error('no cron fire-time within 4 years — malformed expression');
}
