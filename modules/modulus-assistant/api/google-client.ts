// Shared Google API plumbing for the thin Calendar and Tasks clients: the
// FetchLike shape, transient-failure retry, and OAuth access-token refresh
// from a long-lived refresh token. The per-API clients (api/calendar.ts,
// api/tasks.ts) layer their own URL building, response flattening, and typed
// error classes on top of this core so error messages and `instanceof` checks
// stay specific to each service.

export interface FetchLike {
  (
    input: string,
    init?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      signal?: AbortSignal;
    },
  ): Promise<{
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
    text(): Promise<string>;
  }>;
}

export interface AccessTokenCache {
  token: string;
  expiresAt: number;
}

export interface GoogleOAuthCreds {
  client_id: string;
  client_secret: string;
  refresh_token: string;
}

// Transient Google API failures: rate-limited or temporary server errors.
// Anything else (auth, validation, 404) is the caller's bug and shouldn't be
// retried.
export function isTransient(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

export async function fetchWithRetry(
  fetchImpl: FetchLike,
  url: string,
  init: Parameters<FetchLike>[1],
  attempts = 3,
  baseDelayMs = 250,
): Promise<Awaited<ReturnType<FetchLike>>> {
  let last: Awaited<ReturnType<FetchLike>> | null = null;
  for (let i = 0; i < attempts; i++) {
    const res = await fetchImpl(url, init);
    if (!isTransient(res.status) || i === attempts - 1) return res;
    last = res;
    // Light jitter so two concurrent clients don't lock-step into Google's
    // rate limiter.
    const delay = baseDelayMs * Math.pow(2, i) + Math.floor(Math.random() * 100);
    await new Promise((r) => setTimeout(r, delay));
  }
  return last!;
}

export interface GoogleApiOptions {
  creds: GoogleOAuthCreds;
  // Short label used in thrown error messages, e.g. 'calendar' / 'tasks'.
  label: string;
  // Build the absolute request URL from the per-API relative path.
  buildUrl: (path: string) => string;
  // Construct the service-specific typed error so callers' `instanceof`
  // checks (CalendarApiError / TasksApiError) keep working.
  makeError: (status: number, message: string) => Error;
  fetchImpl?: FetchLike;
  // Pluggable cache so the loader can hand in a single shared cache that
  // survives across calls within a process.
  cache?: { current: AccessTokenCache | null };
  now?: () => number;
  signal?: AbortSignal;
}

// Returns an authed `api(method, path, body)` that refreshes (and caches) the
// access token, retries transient failures, and decodes JSON / 204 No Content.
export function createGoogleApi(opts: GoogleApiOptions): {
  api: (method: string, path: string, body?: Record<string, unknown>) => Promise<unknown>;
} {
  const fetchImpl = (opts.fetchImpl ?? (fetch as unknown as FetchLike)) as FetchLike;
  const now = opts.now ?? Date.now;
  const cache = opts.cache ?? { current: null };

  async function getAccessToken(): Promise<string> {
    if (cache.current && cache.current.expiresAt - now() > 30_000) {
      return cache.current.token;
    }
    const body = new URLSearchParams({
      client_id: opts.creds.client_id,
      client_secret: opts.creds.client_secret,
      refresh_token: opts.creds.refresh_token,
      grant_type: 'refresh_token',
    });
    const res = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (!res.ok) {
      throw opts.makeError(res.status, `token refresh failed (${res.status})`);
    }
    const j = (await res.json()) as { access_token: string; expires_in: number };
    cache.current = {
      token: j.access_token,
      expiresAt: now() + j.expires_in * 1000,
    };
    return j.access_token;
  }

  async function api(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    const token = await getAccessToken();
    const url = opts.buildUrl(path);
    const init: {
      method: string;
      headers: Record<string, string>;
      body?: string;
      signal?: AbortSignal;
    } = {
      method,
      headers: { authorization: `Bearer ${token}` },
    };
    if (opts.signal) {
      init.signal = opts.signal;
    }
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetchWithRetry(fetchImpl, url, init);
    if (!res.ok) {
      throw opts.makeError(res.status, `${opts.label} ${method} ${path} failed (${res.status})`);
    }
    if (res.status === 204) return null;
    return (await res.json()) as unknown;
  }

  return { api };
}
