// Codex backend client. Calls the ChatGPT Codex Responses API with the OAuth
// access token + chatgpt-account-id header — the same surface the Codex CLI
// uses when authenticated with a ChatGPT subscription.
//
// The ChatGPT Codex backend ONLY accepts streaming requests (`stream: true`);
// a non-streaming call is rejected with 400 "Stream must be set to true". So we
// always stream, read the Server-Sent Events, and accumulate the output text +
// final usage. We don't surface the stream to the user live — Modulus's local
// model summarises the finished result — so this is purely an internal detail
// of talking to the backend.

import { randomUUID } from 'node:crypto';
import { composeAbort } from '../../../src/util/abort.js';

export interface CodexRequest {
  baseUrl: string;
  accessToken: string;
  accountId: string | null;
  model: string;
  // Fully-composed prompt (task + optional context + success criteria).
  prompt: string;
  maxOutputTokens: number;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export interface CodexResult {
  text: string;
  promptTokens?: number;
  completionTokens?: number;
}

export class CodexApiError extends Error {
  constructor(
    public status: number,
    message: string,
    // Seconds to wait before retrying, parsed from a 429's Retry-After header
    // when present. Lets the caller tell the user when the ChatGPT-plan rate
    // limit clears instead of a bare "call failed".
    public retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'CodexApiError';
  }
}

// Read a Retry-After header (delta-seconds or an HTTP date) into seconds.
// Returns undefined when absent or unparseable.
export function parseRetryAfter(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (!raw) return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) return secs;
  const when = Date.parse(raw);
  if (!Number.isNaN(when)) {
    const delta = (when - Date.now()) / 1000;
    if (delta > 0) return delta;
  }
  return undefined;
}

// System instructions handed to Codex for a Modulus handoff. Codex stands in as
// Modulus itself for hard turns, so we (a) tell it what Modulus is, (b) ask it to
// answer in Modulus's first-person voice (its reply is sent to the user
// verbatim), and (c) pin down what it can't do — it has no tools, no data, and
// no memory of the chat beyond what's included in the prompt.
const INSTRUCTIONS =
  'You are Modulus — a small, private, self-hosted personal assistant that runs locally on the ' +
  "user's own hardware (often a Raspberry Pi or mini PC) and talks to them through Telegram. " +
  'Normally a lightweight local model answers, but for this turn it handed the work to you ' +
  'because the task needs more capability than it has. ' +
  'Answer AS Modulus, in the first person, in a warm, concise, direct, no-fluff voice — your reply ' +
  'is sent to the user verbatim, so make it complete and ready to send. ' +
  'You can produce anything text-based: code (full and runnable, never snippets-with-ellipses), ' +
  'explanations, plans, drafts, analysis, calculations. ' +
  'IMPORTANT: you are the reasoning and writing brain only. You cannot run tools, and you cannot ' +
  "see the user's files, calendar, reminders, device, or the earlier conversation beyond what is " +
  'included below. Never claim to have performed an action (e.g. "I\'ve set that reminder") — you ' +
  'cannot. If an action is needed, give the exact content or steps and let the local assistant ' +
  'carry it out. Make reasonable assumptions rather than asking questions, and state them briefly.';

interface ResponsesApiOutputContent {
  type?: string;
  text?: string;
}
interface ResponsesApiOutputItem {
  type?: string;
  content?: ResponsesApiOutputContent[];
}
interface ResponsesApiResponse {
  output_text?: string | string[];
  output?: ResponsesApiOutputItem[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  error?: { message?: string };
}

// One decoded SSE event from the Responses streaming API. We only model the
// fields we act on; the backend sends many more event types we ignore.
interface ResponsesStreamEvent {
  type?: string;
  // Present on `response.output_text.delta`.
  delta?: string;
  // Present on `response.completed` / `response.failed` (the full response obj).
  response?: ResponsesApiResponse;
  // Present on `error` events.
  error?: { message?: string };
  message?: string;
}

// Pull the assistant text out of a Responses API payload. Handles both the
// `output_text` convenience field and the structured `output[].content[]` form.
export function extractText(json: ResponsesApiResponse): string {
  if (typeof json.output_text === 'string' && json.output_text.trim()) {
    return json.output_text.trim();
  }
  if (Array.isArray(json.output_text)) {
    const joined = json.output_text.join('').trim();
    if (joined) return joined;
  }
  if (Array.isArray(json.output)) {
    const parts: string[] = [];
    for (const item of json.output) {
      if (!item?.content) continue;
      for (const c of item.content) {
        if (
          (c.type === 'output_text' || c.type === 'text' || !c.type) &&
          typeof c.text === 'string'
        ) {
          parts.push(c.text);
        }
      }
    }
    const joined = parts.join('').trim();
    if (joined) return joined;
  }
  return '';
}

export async function callCodex(req: CodexRequest): Promise<CodexResult> {
  const fetchImpl = req.fetchImpl ?? fetch;

  // Compose the caller's signal with our own timeout so a hung backend can't
  // pin the user queue forever.
  const timeoutCtl = new AbortController();
  const timeoutId = setTimeout(() => timeoutCtl.abort(), req.timeoutMs);
  timeoutId.unref?.();
  const signal = req.signal ? composeAbort(req.signal, timeoutCtl.signal) : timeoutCtl.signal;

  const headers: Record<string, string> = {
    authorization: `Bearer ${req.accessToken}`,
    'content-type': 'application/json',
    // Codex CLI parity headers. The account id binds the request to the
    // ChatGPT subscription that should be billed.
    'openai-beta': 'responses=experimental',
    originator: 'codex_cli_rs',
    session_id: randomUUID(),
  };
  if (req.accountId) headers['chatgpt-account-id'] = req.accountId;

  // Note: the ChatGPT Codex backend rejects `max_output_tokens` ("Unsupported
  // parameter") — it caps output server-side, so req.maxOutputTokens is not
  // sent. The setting is retained for forward-compat but currently advisory.
  const body = {
    model: req.model,
    instructions: INSTRUCTIONS,
    input: [
      {
        role: 'user',
        content: [{ type: 'input_text', text: req.prompt }],
      },
    ],
    // The ChatGPT Codex backend mandates streaming; see the file header.
    stream: true,
    store: false,
  };

  let res: Response;
  try {
    res = await fetchImpl(`${req.baseUrl.replace(/\/$/, '')}/responses`, {
      method: 'POST',
      headers: { ...headers, accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    clearTimeout(timeoutId);
    throw e;
  }

  // Error responses come back as a normal (non-stream) JSON/text body.
  if (!res.ok) {
    clearTimeout(timeoutId);
    const text = await res.text().catch(() => '');
    throw new CodexApiError(
      res.status,
      `Codex responded ${res.status}: ${text.slice(0, 400)}`,
      parseRetryAfter(res.headers),
    );
  }
  if (!res.body) {
    clearTimeout(timeoutId);
    throw new CodexApiError(200, 'Codex returned no response body');
  }

  try {
    return await readResponsesStream(res.body);
  } finally {
    clearTimeout(timeoutId);
  }
}

// Read a Responses API Server-Sent Events stream and fold it into a single
// result. Text is accumulated from `response.output_text.delta` events; the
// final `response.completed` event carries usage and the full output (used as a
// fallback when no deltas were seen). A `response.failed` / `error` event is
// surfaced as a CodexApiError.
export async function readResponsesStream(
  stream: ReadableStream<Uint8Array>,
): Promise<CodexResult> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let deltaText = '';
  let finalText = '';
  let promptTokens: number | undefined;
  let completionTokens: number | undefined;

  const handleEvent = (payload: string): void => {
    if (!payload || payload === '[DONE]') return;
    let evt: ResponsesStreamEvent;
    try {
      evt = JSON.parse(payload) as ResponsesStreamEvent;
    } catch {
      return; // skip malformed event lines
    }
    const type = evt.type ?? '';
    if (type === 'response.output_text.delta' && typeof evt.delta === 'string') {
      deltaText += evt.delta;
    } else if (type === 'response.completed' && evt.response) {
      const ft = extractText(evt.response);
      if (ft) finalText = ft;
      const pt = evt.response.usage?.input_tokens ?? evt.response.usage?.prompt_tokens;
      const ct = evt.response.usage?.output_tokens ?? evt.response.usage?.completion_tokens;
      if (typeof pt === 'number') promptTokens = pt;
      if (typeof ct === 'number') completionTokens = ct;
    } else if (type === 'response.failed' || type === 'error') {
      const msg =
        evt.response?.error?.message ?? evt.error?.message ?? evt.message ?? 'Codex stream error';
      throw new CodexApiError(200, `Codex returned an error: ${msg}`);
    }
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line.startsWith('data:')) handleEvent(line.slice(5).trim());
      }
    }
    const tail = buffer.trim();
    if (tail.startsWith('data:')) handleEvent(tail.slice(5).trim());
  } catch (err) {
    // On error (e.g. response.failed thrown out of handleEvent), cancel the
    // body so the underlying connection is released, then re-throw.
    await reader.cancel().catch(() => {});
    throw err;
  } finally {
    reader.releaseLock();
  }

  const text = deltaText || finalText;
  if (!text) throw new CodexApiError(200, 'Codex returned an empty response');

  const result: CodexResult = { text };
  if (typeof promptTokens === 'number') result.promptTokens = promptTokens;
  if (typeof completionTokens === 'number') result.completionTokens = completionTokens;
  return result;
}

// Lightweight token check used by the auth flow to catch the "identity-only
// scope" trap (OpenClaw #29418): a token that authenticates but can't reach the
// Codex backend. Returns the HTTP status so the caller can message precisely.
export async function probeAccess(opts: {
  baseUrl: string;
  accessToken: string;
  accountId: string | null;
  model: string;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: boolean; status: number; detail: string }> {
  try {
    const result = await callCodex({
      baseUrl: opts.baseUrl,
      accessToken: opts.accessToken,
      accountId: opts.accountId,
      model: opts.model,
      prompt: 'Reply with the single word: ok',
      maxOutputTokens: 16,
      timeoutMs: 30_000,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
    return { ok: true, status: 200, detail: result.text.slice(0, 80) };
  } catch (e) {
    if (e instanceof CodexApiError) {
      return { ok: false, status: e.status, detail: e.message };
    }
    return { ok: false, status: 0, detail: e instanceof Error ? e.message : String(e) };
  }
}
