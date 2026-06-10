// Natural language time parser for reminders. Accepts:
//   - ISO 8601 datetime strings
//   - "in N minutes/hours/days"
//   - "tomorrow at H[:mm] [am|pm]"
//   - "at H[:mm] [am|pm]"  (today; rolls over to tomorrow if already past)

export function parseReminderTime(input: string, now: Date = new Date()): Date | null {
  const s = input.trim().toLowerCase();

  // ISO 8601 — must start with a digit and have a date separator
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const d = new Date(input);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // "in N units"
  const inMatch = s.match(/^in (\d+)\s*(minutes?|hours?|days?)/);
  if (inMatch) {
    const n = parseInt(inMatch[1]!);
    const unit = inMatch[2]!;
    const d = new Date(now);
    if (unit.startsWith('min')) d.setMinutes(d.getMinutes() + n);
    else if (unit.startsWith('hour')) d.setHours(d.getHours() + n);
    else d.setDate(d.getDate() + n);
    return d;
  }

  // "tomorrow at H[:mm] [am|pm]"
  const tomMatch = s.match(/^tomorrow at (\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (tomMatch) {
    const hour = resolveHour(parseInt(tomMatch[1]!), tomMatch[3] as 'am' | 'pm' | undefined);
    const minute = parseInt(tomMatch[2] ?? '0');
    if (hour === null || minute > 59) return null;
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    d.setHours(hour, minute, 0, 0);
    return d;
  }

  // "tomorrow morning" / "tomorrow afternoon" / "tomorrow evening" / "tomorrow night"
  // Map to a sensible default hour. The 0.8b model gives up rather than picking
  // one, so a deterministic default lets the reminder land instead of bouncing
  // the user with a clarifying question.
  const tomPart = s.match(/^tomorrow\s+(morning|afternoon|evening|night)$/);
  if (tomPart) {
    const hourByPart: Record<string, number> = {
      morning: 9,
      afternoon: 14,
      evening: 18,
      night: 20,
    };
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    d.setHours(hourByPart[tomPart[1]!]!, 0, 0, 0);
    return d;
  }

  // Bare "morning" / "afternoon" / "evening" / "night" — today, rolling over to
  // tomorrow if the default hour is already past.
  const partOfDay = s.match(/^(morning|afternoon|evening|night)$/);
  if (partOfDay) {
    const hourByPart: Record<string, number> = {
      morning: 9,
      afternoon: 14,
      evening: 18,
      night: 20,
    };
    const d = new Date(now);
    d.setHours(hourByPart[partOfDay[1]!]!, 0, 0, 0);
    if (d <= now) d.setDate(d.getDate() + 1);
    return d;
  }

  // "at H[:mm] [am|pm]"
  const atMatch = s.match(/^(?:today )?at (\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (atMatch) {
    const hour = resolveHour(parseInt(atMatch[1]!), atMatch[3] as 'am' | 'pm' | undefined);
    const minute = parseInt(atMatch[2] ?? '0');
    if (hour === null || minute > 59) return null;
    const d = new Date(now);
    d.setHours(hour, minute, 0, 0);
    // If already past, push to tomorrow
    if (d <= now) d.setDate(d.getDate() + 1);
    return d;
  }

  // Bare "H:MM" (24h clock, e.g. "20:00"). Today; rolls over to tomorrow if past.
  const hhmmMatch = s.match(/^(\d{1,2}):(\d{2})$/);
  if (hhmmMatch) {
    const h = parseInt(hhmmMatch[1]!);
    const minute = parseInt(hhmmMatch[2]!);
    if (h < 0 || h > 23 || minute > 59) return null;
    const d = new Date(now);
    d.setHours(h, minute, 0, 0);
    if (d <= now) d.setDate(d.getDate() + 1);
    return d;
  }

  // Bare "Hpm" / "H:MMam" (no leading "at"). Today; rolls over if past.
  const bareAmPm = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
  if (bareAmPm) {
    const hour = resolveHour(parseInt(bareAmPm[1]!), bareAmPm[3] as 'am' | 'pm');
    const minute = parseInt(bareAmPm[2] ?? '0');
    if (hour === null || minute > 59) return null;
    const d = new Date(now);
    d.setHours(hour, minute, 0, 0);
    if (d <= now) d.setDate(d.getDate() + 1);
    return d;
  }

  return null;
}

// Returns the 24h hour, or null if the input is out of range. With am/pm
// the hour must be 1-12; without it, 0-23. "25:00" or "13pm" return null
// instead of silently rolling into a wrong time.
function resolveHour(h: number, ampm?: 'am' | 'pm'): number | null {
  if (ampm) {
    if (h < 1 || h > 12) return null;
    if (ampm === 'pm' && h < 12) return h + 12;
    if (ampm === 'am' && h === 12) return 0;
    return h;
  }
  if (h < 0 || h > 23) return null;
  return h;
}

// Split a raw /remind arg string into { timeStr, message }.
// Examples:
//   "in 30 minutes Call doctor"  → { timeStr: "in 30 minutes", message: "Call doctor" }
//   "tomorrow at 9am Stand-up"   → { timeStr: "tomorrow at 9am", message: "Stand-up" }
//   "at 3pm Review PR"           → { timeStr: "at 3pm", message: "Review PR" }
export function splitReminderArgs(input: string): { timeStr: string; message: string } | null {
  const s = input.trim();

  const patterns: RegExp[] = [
    /^(in \d+\s*(?:minutes?|hours?|days?))\s+(.+)/i,
    /^(tomorrow at \d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s+(.+)/i,
    /^(tomorrow\s+(?:morning|afternoon|evening|night))\s+(.+)/i,
    /^((?:today )?at \d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s+(.+)/i,
    /^(\d{4}-\d{2}-\d{2}(?:T[\d:]+)?(?:Z|[+-]\d{2}:\d{2})?)\s+(.+)/i,
    // Bare HH:MM (24h)
    /^(\d{1,2}:\d{2})\s+(.+)/i,
    // Bare Hpm / H:MMam
    /^(\d{1,2}(?::\d{2})?\s*(?:am|pm))\s+(.+)/i,
    // Bare "morning" / "afternoon" / "evening" / "night"
    /^(morning|afternoon|evening|night)\s+(.+)/i,
  ];

  for (const pat of patterns) {
    const m = s.match(pat);
    if (m) return { timeStr: m[1]!.trim(), message: m[2]!.trim() };
  }
  return null;
}
