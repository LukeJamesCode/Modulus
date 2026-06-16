// Natural-language schedule parsing. Turns "every weekday at 8am" or "in 20
// minutes" into a concrete spec the scheduler already understands: a one-shot
// epoch, or a 5-field cron expression + IANA time zone.
//
// Two tiers, mirroring agent-router: a deterministic rules pass covers the
// common 90% with no model call, and only genuinely novel phrasings fall
// through to a tiny tools-profile model that emits structured JSON. Either way
// the result is validated back through cron.ts / Date math before it can
// persist, so a hallucinated spec can never reach the scheduler.
//
// Pure and explicit-tz: the caller resolves the time zone (host zone by
// default) and passes it in, so this stays unit-testable with FakeLLM and a
// fixed `now`.

import { parseCron, nextFireAfter } from './cron.js';
import type { LLM } from './llm.js';
import type { Logger } from '../util/log.js';

export interface ParseScheduleContext {
  // The reference instant for relative phrases ("in 20 min", "tomorrow").
  now: Date;
  // IANA zone (e.g. "America/Denver") the wall-clock phrases resolve against.
  timeZone: string;
  // Optional fallback model. Omit it to stay rules-only (tests, offline).
  llm?: LLM;
  log?: Logger;
}

export type ScheduleSpec =
  | { kind: 'once'; at: number }
  | { kind: 'recurring'; cron: string; timeZone: string }
  | { error: string };

const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

const UNIT_MS: Record<string, number> = {
  second: 1000, sec: 1000, secs: 1000, seconds: 1000,
  minute: 60_000, min: 60_000, mins: 60_000, minutes: 60_000,
  hour: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hours: 3_600_000,
  day: 86_400_000, days: 86_400_000,
  week: 604_800_000, weeks: 604_800_000,
};

const ONE_YEAR_MS = 365 * 86_400_000;

// ---------------------------------------------------------------------------
// Time-zone wall-clock math. Computing "5pm tomorrow in zone X" → epoch is the
// one genuinely fiddly bit: JS has no built-in zoned constructor. We interpret
// the wall-clock fields as if UTC, then correct by the zone's offset at that
// instant, refining once so a DST boundary doesn't skew the result.
// ---------------------------------------------------------------------------

function offsetMsAt(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (t: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === t)?.value ?? '0');
  const asUTC = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUTC - at.getTime();
}

function zonedWallToEpoch(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  timeZone: string,
): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const off1 = offsetMsAt(timeZone, new Date(guess));
  let epoch = guess - off1;
  const off2 = offsetMsAt(timeZone, new Date(epoch));
  if (off2 !== off1) epoch = guess - off2;
  return epoch;
}

interface WallParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

function wallPartsInZone(at: Date, timeZone: string): WallParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(at);
  const get = (t: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === t)?.value ?? '';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    weekday: WEEKDAYS[get('weekday').toLowerCase()] ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Time-of-day parsing: "8", "8am", "8:30pm", "17:00", "noon", "midnight".
// ---------------------------------------------------------------------------

interface TimeOfDay {
  hour: number;
  minute: number;
}

function parseTimeOfDay(text: string): TimeOfDay | null {
  const t = text.trim().toLowerCase();
  if (t === 'noon' || t === 'midday') return { hour: 12, minute: 0 };
  if (t === 'midnight') return { hour: 0, minute: 0 };
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?$/.exec(t);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const mer = m[3];
  if (minute > 59) return null;
  if (mer === 'pm' || mer === 'p') {
    if (hour < 1 || hour > 12) return null;
    if (hour !== 12) hour += 12;
  } else if (mer === 'am' || mer === 'a') {
    if (hour < 1 || hour > 12) return null;
    if (hour === 12) hour = 0;
  } else if (hour > 23) {
    return null;
  }
  return { hour, minute };
}

// Pull a trailing "... at <time>" (or a bare "<time>") off a phrase, returning
// the time and the phrase with the time clause removed. Defaults applied by
// the caller so "every day" and "every day at 8" can diverge.
function extractTime(text: string): { time: TimeOfDay | null; rest: string } {
  const at = /\bat\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm|a|p)?|noon|midday|midnight)\b/i.exec(text);
  if (at) {
    const time = parseTimeOfDay(at[1]!);
    if (time) return { time, rest: (text.slice(0, at.index) + text.slice(at.index + at[0].length)).trim() };
  }
  // A trailing bare clock with no "at" — "tomorrow 5pm", "every monday 9am".
  const bare = /\b(\d{1,2}(?::\d{2})\s*(?:am|pm)?|\d{1,2}\s*(?:am|pm)|noon|midnight)\s*$/i.exec(text);
  if (bare) {
    const time = parseTimeOfDay(bare[1]!);
    if (time) return { time, rest: text.slice(0, bare.index).trim() };
  }
  return { time: null, rest: text };
}

// ---------------------------------------------------------------------------
// Cron field helpers.
// ---------------------------------------------------------------------------

function cron(minute: string, hour: string, dom: string, month: string, dow: string): string {
  return `${minute} ${hour} ${dom} ${month} ${dow}`;
}

// Validate a built cron string, returning it or null if it doesn't parse /
// can't fire — never let an unparseable expression escape the rules pass.
function validatedCron(expr: string, timeZone: string, now: Date): string | null {
  try {
    const parsed = parseCron(expr);
    nextFireAfter(parsed, now, timeZone); // throws if it can never fire
    return expr;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Rules pass.
// ---------------------------------------------------------------------------

function ruleParse(text: string, ctx: ParseScheduleContext): ScheduleSpec | null {
  const raw = text.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!raw) return null;

  // "in N <unit>" — one-shot relative. Zone-independent.
  const rel = /^in\s+(?:(an?|a)\s+)?(\d+)?\s*(second|seconds|sec|secs|minute|minutes|min|mins|hour|hours|hr|hrs|day|days|week|weeks)$/.exec(raw)
    ?? /^in\s+(an?|a)\s+(second|minute|hour|day|week)$/.exec(raw);
  if (rel) {
    // Forms: "in 20 minutes", "in an hour", "in a day".
    const n = rel[2] && /^\d+$/.test(rel[2]) ? Number(rel[2]) : 1;
    const unit = (rel[3] ?? rel[2])!;
    const ms = UNIT_MS[unit];
    if (ms && n > 0) return { kind: 'once', at: ctx.now.getTime() + n * ms };
  }

  // Recurring: "every ...", "daily/hourly", "each ...".
  const recurring = ruleRecurring(raw, ctx);
  if (recurring) return recurring;

  // One-shot with a date word.
  const once = ruleOnce(raw, ctx);
  if (once) return once;

  // ISO / absolute date the platform can parse directly ("2026-06-20T17:00").
  // Only trust an unambiguous parse: a bare "8" must not become epoch 8.
  if (/\d{4}-\d{2}-\d{2}/.test(text) || /\d{1,2}:\d{2}/.test(text)) {
    const ms = Date.parse(text);
    if (Number.isFinite(ms)) return finalizeOnce(ms, ctx, true);
  }

  return null;
}

function ruleRecurring(raw: string, ctx: ParseScheduleContext): ScheduleSpec | null {
  const isEvery =
    /^(every|each)\b/.test(raw) ||
    /^(daily|hourly|weekly|monthly)\b/.test(raw) ||
    // "on the 1st [at noon]" reads as a monthly recurrence, not a one-shot.
    /^on\s+the\s+\d{1,2}(?:st|nd|rd|th)?\b/.test(raw);
  if (!isEvery) return null;
  const mk = (expr: string): ScheduleSpec | null => {
    const ok = validatedCron(expr, ctx.timeZone, ctx.now);
    return ok ? { kind: 'recurring', cron: ok, timeZone: ctx.timeZone } : null;
  };
  // A single cron field can't step past its own range: "*/90" in the 0–59
  // minute field collapses to just minute 0 (hourly), "*/25" in 0–23 hours to
  // midnight (daily). Reject intervals that would silently land on the wrong
  // cadence rather than mislead the user.
  const tooCoarse = (n: number, unit: string): ScheduleSpec => ({
    error: `I can't make a recurring schedule for "every ${n} ${unit}" — a fixed interval tops out at 59 minutes or 23 hours. Try a specific time like "every day at 9am".`,
  });
  const everyHours = (n: number): ScheduleSpec | null => {
    if (!Number.isFinite(n) || n <= 0) return null;
    if (n <= 23) return mk(cron('0', n === 1 ? '*' : `*/${n}`, '*', '*', '*'));
    if (n === 24) return mk(cron('0', '0', '*', '*', '*')); // "every 24 hours" = daily
    return tooCoarse(n, 'hours');
  };

  // Sub-hour / multi-hour intervals — no specific time of day.
  let m = /^every\s+(\d+)?\s*(minute|minutes|min|mins)$/.exec(raw);
  if (m) {
    const n = m[1] ? Number(m[1]) : 1;
    if (n <= 0) return null;
    if (n <= 59) return mk(cron(n === 1 ? '*' : `*/${n}`, '*', '*', '*', '*'));
    // Past 59 a minute field can't step; re-express exact-hour multiples
    // ("every 120 minutes" → every 2 hours), reject the rest.
    return n % 60 === 0 ? everyHours(n / 60) : tooCoarse(n, 'minutes');
  }
  if (/^(hourly|every hour)$/.test(raw)) return mk(cron('0', '*', '*', '*', '*'));
  m = /^every\s+(\d+)\s*(hour|hours|hr|hrs)$/.exec(raw);
  if (m) return everyHours(Number(m[1]));

  const { time, rest } = extractTime(raw);
  const h = time?.hour ?? 9;
  const min = time?.minute ?? 0;

  // "every weekday" / "weekdays" → Mon–Fri.
  if (/^every\s+(week\s?days?|business\s+days?)$/.test(rest)) {
    return mk(cron(String(min), String(h), '*', '*', '1-5'));
  }
  // "every weekend" → Sat + Sun.
  if (/^every\s+weekends?$/.test(rest)) {
    return mk(cron(String(min), String(h), '*', '*', '0,6'));
  }
  // "every day" / "daily".
  if (/^(every\s+day|daily|each\s+day|every\s+morning|every\s+evening|every\s+night)$/.test(rest)) {
    // Sensible default times for time-of-day words when no explicit time given.
    let hr = h;
    if (!time) {
      if (/morning/.test(rest)) hr = 8;
      else if (/evening/.test(rest)) hr = 18;
      else if (/night/.test(rest)) hr = 21;
    }
    return mk(cron(String(min), String(hr), '*', '*', '*'));
  }
  // "every monday", "every mon and wed", "every tuesday, thursday".
  const dowMatch = /^every\s+(.+?)$/.exec(rest);
  if (dowMatch) {
    const days = parseWeekdayList(dowMatch[1]!);
    if (days.length > 0) {
      return mk(cron(String(min), String(h), '*', '*', days.sort((a, b) => a - b).join(',')));
    }
  }
  // "every week" / "weekly" with no day → anchor to today's weekday.
  if (/^(every\s+week|weekly)$/.test(rest)) {
    const dow = wallPartsInZone(ctx.now, ctx.timeZone).weekday;
    return mk(cron(String(min), String(h), '*', '*', String(dow)));
  }
  // "every month" / "monthly" [on the Dth] → default day-of-month 1.
  if (/^(every\s+month|monthly)$/.test(rest)) {
    return mk(cron(String(min), String(h), '1', '*', '*'));
  }
  const monthDay = /^(?:every\s+month\s+on\s+the|monthly\s+on\s+the|on\s+the)\s+(\d{1,2})(?:st|nd|rd|th)?$/.exec(rest);
  if (monthDay) {
    const dom = Number(monthDay[1]);
    if (dom >= 1 && dom <= 31) return mk(cron(String(min), String(h), String(dom), '*', '*'));
  }
  return null;
}

function parseWeekdayList(text: string): number[] {
  const tokens = text.split(/[\s,]+|\band\b/).map((t) => t.trim()).filter(Boolean);
  const out = new Set<number>();
  for (const tok of tokens) {
    const d = WEEKDAYS[tok];
    if (d === undefined) return []; // any unknown token → not a pure weekday list
    out.add(d);
  }
  return [...out];
}

function ruleOnce(raw: string, ctx: ParseScheduleContext): ScheduleSpec | null {
  const { time, rest } = extractTime(raw);

  // "tomorrow [at TIME]" — default 9am.
  if (/^tomorrow$/.test(rest)) {
    return onceOnDayOffset(ctx, 1, time?.hour ?? 9, time?.minute ?? 0);
  }
  // "today [at TIME]" / "tonight [at TIME]" / "this evening".
  if (/^(today|this\s+(morning|afternoon|evening))$/.test(rest)) {
    const hr = time?.hour ?? (/morning/.test(rest) ? 9 : /afternoon/.test(rest) ? 14 : 18);
    return onceOnDayOffset(ctx, 0, hr, time?.minute ?? 0, /* allowPast */ false);
  }
  if (/^(tonight)$/.test(rest)) {
    return onceOnDayOffset(ctx, 0, time?.hour ?? 20, time?.minute ?? 0, false);
  }
  // "(this|next) <weekday> [at TIME]" / "on <weekday> [at TIME]".
  const dow = /^(?:this|next|on|on\s+the\s+coming|coming)\s+([a-z]+)$/.exec(rest)
    ?? /^([a-z]+)$/.exec(rest);
  if (dow) {
    const target = WEEKDAYS[dow[1]!];
    if (target !== undefined) {
      const forceNext = /^next\b/.test(rest);
      return onceOnWeekday(ctx, target, time?.hour ?? 9, time?.minute ?? 0, forceNext);
    }
  }
  // Bare time only — "at 5pm" / "5pm". Today if still ahead, else tomorrow.
  if (!rest && time) {
    const today = onceOnDayOffset(ctx, 0, time.hour, time.minute, true);
    return today;
  }
  return null;
}

function onceOnDayOffset(
  ctx: ParseScheduleContext,
  dayOffset: number,
  hour: number,
  minute: number,
  rollIfPast = true,
): ScheduleSpec | null {
  const w = wallPartsInZone(ctx.now, ctx.timeZone);
  const base = zonedWallToEpoch(w.year, w.month, w.day, hour, minute, ctx.timeZone);
  let at = base + dayOffset * 86_400_000;
  // Recompute from the shifted wall day so a DST transition between today and
  // the target day keeps the wall-clock time exact (not 86_400_000 ms drift).
  if (dayOffset !== 0) {
    const shifted = wallPartsInZone(new Date(at), ctx.timeZone);
    at = zonedWallToEpoch(shifted.year, shifted.month, shifted.day, hour, minute, ctx.timeZone);
  }
  if (at <= ctx.now.getTime()) {
    if (!rollIfPast) return { error: 'That time has already passed today. Try "tomorrow" or a later time.' };
    const next = wallPartsInZone(new Date(at + 86_400_000), ctx.timeZone);
    at = zonedWallToEpoch(next.year, next.month, next.day, hour, minute, ctx.timeZone);
  }
  return finalizeOnce(at, ctx, false);
}

function onceOnWeekday(
  ctx: ParseScheduleContext,
  targetDow: number,
  hour: number,
  minute: number,
  forceNext: boolean,
): ScheduleSpec | null {
  const w = wallPartsInZone(ctx.now, ctx.timeZone);
  let delta = (targetDow - w.weekday + 7) % 7;
  if (delta === 0) {
    const todayAt = zonedWallToEpoch(w.year, w.month, w.day, hour, minute, ctx.timeZone);
    if (forceNext || todayAt <= ctx.now.getTime()) delta = 7;
  } else if (forceNext && delta < 7) {
    // "next monday" when today isn't monday still means the upcoming one.
  }
  return onceOnDayOffset(ctx, delta, hour, minute, true);
}

function finalizeOnce(at: number, ctx: ParseScheduleContext, rejectPast: boolean): ScheduleSpec {
  if (!Number.isFinite(at)) return { error: 'Could not work out a time from that.' };
  if (rejectPast && at <= ctx.now.getTime()) {
    return { error: 'That time is in the past — pick a future time.' };
  }
  if (at - ctx.now.getTime() > ONE_YEAR_MS) {
    return { error: 'That is more than a year away — pick something sooner.' };
  }
  return { kind: 'once', at: Math.trunc(at) };
}

// ---------------------------------------------------------------------------
// Model fallback. A tiny tools-profile completion converts a novel phrasing to
// JSON, which we validate exactly like a rules result before trusting it.
// ---------------------------------------------------------------------------

async function modelParse(text: string, ctx: ParseScheduleContext): Promise<ScheduleSpec | null> {
  if (!ctx.llm) return null;
  const profiles = ctx.llm.listProfiles();
  const profile: 'tools' | 'chat' = profiles.tools ? 'tools' : 'chat';
  const w = wallPartsInZone(ctx.now, ctx.timeZone);
  const nowLine = `${w.year}-${pad(w.month)}-${pad(w.day)} ${pad(w.hour)}:${pad(w.minute)} (${ctx.timeZone})`;
  const messages = [
    {
      role: 'system' as const,
      content:
        'You convert a scheduling phrase into JSON. Reply with ONLY a JSON object, no prose.\n' +
        'For a one-time schedule: {"once":"YYYY-MM-DDTHH:MM"} in the user\'s local time.\n' +
        'For a repeating schedule: {"cron":"M H DOM MON DOW"} (5-field cron, DOW 0=Sun..6=Sat, * for any).\n' +
        'If the phrase is not a schedule, reply {"error":"reason"}.',
    },
    {
      role: 'user' as const,
      content: `Now: ${nowLine}\nPhrase: ${text}\nJSON:`,
    },
  ];
  let out = '';
  try {
    for await (const chunk of ctx.llm.chat({ profile, messages, maxTokens: 64, thinkMode: 'off' })) {
      out += chunk.delta ?? '';
    }
  } catch (e) {
    ctx.log?.warn('schedule-parse: model call failed', {
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
  return interpretModelJson(out, ctx);
}

function interpretModelJson(raw: string, ctx: ParseScheduleContext): ScheduleSpec | null {
  const match = /\{[\s\S]*\}/.exec(raw);
  if (!match) return null;
  let obj: { once?: unknown; cron?: unknown; error?: unknown };
  try {
    obj = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (typeof obj.cron === 'string') {
    const ok = validatedCron(obj.cron.trim(), ctx.timeZone, ctx.now);
    if (ok) return { kind: 'recurring', cron: ok, timeZone: ctx.timeZone };
  }
  if (typeof obj.once === 'string') {
    // The model emits wall-clock local time; resolve it through the zone so a
    // bare "2026-06-20T17:00" lands at 17:00 in the user's zone, not UTC.
    const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(obj.once.trim());
    if (m) {
      const at = zonedWallToEpoch(+m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!, ctx.timeZone);
      return finalizeOnce(at, ctx, true);
    }
    const ms = Date.parse(obj.once);
    if (Number.isFinite(ms)) return finalizeOnce(ms, ctx, true);
  }
  return null;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

export async function parseSchedule(text: string, ctx: ParseScheduleContext): Promise<ScheduleSpec> {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return { error: 'Say when — e.g. "in 20 minutes", "every weekday at 8am".' };

  const ruled = ruleParse(trimmed, ctx);
  // A rule that produced a hard error (past time) is authoritative — don't let
  // the model paper over it.
  if (ruled && 'error' in ruled) return ruled;
  if (ruled) return ruled;

  const modelled = await modelParse(trimmed, ctx);
  if (modelled) return modelled;

  return {
    error: `I couldn't read a time from "${trimmed}". Try "in 30 minutes", "tomorrow at 9", or "every weekday at 8am".`,
  };
}

// Render a spec back to a short human phrase for previews / confirmations.
export function describeSpec(spec: ScheduleSpec, timeZone: string): string {
  if ('error' in spec) return spec.error;
  if (spec.kind === 'once') {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(spec.at));
  }
  return `repeats on cron \`${spec.cron}\` (${timeZone})`;
}

// Resolve the host's IANA time zone — the default callers pass when the user
// hasn't configured one. Never throws; falls back to UTC if the runtime can't
// report a zone.
export function hostTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
