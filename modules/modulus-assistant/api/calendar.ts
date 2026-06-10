// Thin Google Calendar v3 client. Direct fetch — no SDK dependency. Handles
// access-token refresh from the long-lived refresh token; callers pass the
// settings object so we can lazy-refresh and cache the token in memory. The
// OAuth/retry plumbing lives in ./google-client.ts and is shared with tasks.

import { createGoogleApi, type AccessTokenCache, type FetchLike } from './google-client.js';

export interface CalendarCredentials {
  client_id: string;
  client_secret: string;
  refresh_token: string;
  calendar_id: string;
}

export interface CalendarEvent {
  id: string;
  summary: string;
  // Timed events use ISO date-times. All-day events use Google Calendar's
  // date-only YYYY-MM-DD values so local rendering does not drift through UTC.
  start: string;
  end: string;
  allDay?: boolean;
  startTimeZone?: string;
  endTimeZone?: string;
  htmlLink?: string;
}

export type CalendarAccessTokenCache = AccessTokenCache;

export class CalendarApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'CalendarApiError';
  }
}

export interface CalendarClientOptions {
  creds: CalendarCredentials;
  fetchImpl?: FetchLike;
  // Pluggable cache so the loader can hand in a single shared cache that
  // survives across calls within a process.
  cache?: { current: CalendarAccessTokenCache | null };
  now?: () => number;
  signal?: AbortSignal;
}

export function createCalendarClient(opts: CalendarClientOptions) {
  const calId = encodeURIComponent(opts.creds.calendar_id || 'primary');
  const { api } = createGoogleApi({
    creds: opts.creds,
    label: 'calendar',
    buildUrl: (path) => `https://www.googleapis.com/calendar/v3/calendars/${calId}${path}`,
    makeError: (status, message) => new CalendarApiError(status, message),
    fetchImpl: opts.fetchImpl,
    cache: opts.cache,
    now: opts.now,
    signal: opts.signal,
  });

  function flatten(ev: GoogleEvent): CalendarEvent {
    const allDay = Boolean(ev.start.date && ev.end.date);
    return {
      id: ev.id,
      summary: ev.summary ?? '(no title)',
      start: ev.start.dateTime ?? ev.start.date ?? '',
      end: ev.end.dateTime ?? ev.end.date ?? '',
      ...(allDay ? { allDay } : {}),
      ...(ev.start.timeZone ? { startTimeZone: ev.start.timeZone } : {}),
      ...(ev.end.timeZone ? { endTimeZone: ev.end.timeZone } : {}),
      ...(ev.htmlLink ? { htmlLink: ev.htmlLink } : {}),
    };
  }

  return {
    async listEvents(opts2: {
      timeMin: string;
      timeMax: string;
      max?: number;
    }): Promise<CalendarEvent[]> {
      const params = new URLSearchParams({
        timeMin: opts2.timeMin,
        timeMax: opts2.timeMax,
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: String(opts2.max ?? 50),
      });
      const j = (await api('GET', `/events?${params.toString()}`)) as {
        items?: GoogleEvent[];
      };
      return (j.items ?? []).map(flatten);
    },
    async addEvent(opts2: {
      summary: string;
      start: string;
      end: string;
      description?: string;
      allDay?: boolean;
    }): Promise<CalendarEvent> {
      const body: Record<string, unknown> = {
        summary: opts2.summary,
        start: opts2.allDay ? { date: opts2.start } : { dateTime: opts2.start },
        end: opts2.allDay ? { date: nextLocalDate(opts2.end) } : { dateTime: opts2.end },
      };
      if (opts2.description) body['description'] = opts2.description;
      const j = (await api('POST', '/events', body)) as GoogleEvent;
      return flatten(j);
    },
    async quickAdd(text: string): Promise<CalendarEvent> {
      const params = new URLSearchParams({ text });
      const j = (await api('POST', `/events/quickAdd?${params.toString()}`)) as GoogleEvent;
      return flatten(j);
    },
    async deleteEvent(id: string): Promise<void> {
      await api('DELETE', `/events/${encodeURIComponent(id)}`);
    },
  };
}

export type CalendarClient = ReturnType<typeof createCalendarClient>;

function nextLocalDate(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  d.setDate(d.getDate() + 1);
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

interface GoogleEvent {
  id: string;
  summary?: string;
  htmlLink?: string;
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string; timeZone?: string };
}
