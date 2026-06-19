// One-shot Ollama probes used by the CLI. These don't go through the LLM
// interface because the CLI runs without a logger / circuit breaker / profile
// table — it just wants to know whether the server is up and which models it
// has.

export interface ProbeResult {
  ok: boolean;
  models: string[];
  error?: string;
}

// Coarse buckets for surfacing *why* a remote Ollama is down: a refused
// connection means the machine is up but Ollama isn't listening there (likely
// OLLAMA_HOST not set to 0.0.0.0), while unreachable/timeout means the machine
// itself is off or the address is wrong.
export type ProbeErrorKind = 'refused' | 'unreachable' | 'dns' | 'timeout' | 'http' | 'unknown';

export function classifyProbeError(error: string | undefined): ProbeErrorKind | null {
  if (!error) return null;
  const e = error.toUpperCase();
  if (e.includes('ECONNREFUSED') || e.includes('CONNECTION REFUSED')) return 'refused';
  if (e.includes('EHOSTUNREACH') || e.includes('ENETUNREACH') || e.includes('EHOSTDOWN'))
    return 'unreachable';
  if (e.includes('ENOTFOUND') || e.includes('EAI_AGAIN')) return 'dns';
  if (e.includes('ETIMEDOUT') || e.includes('TIMEOUT') || e.includes('ABORT')) return 'timeout';
  if (e.startsWith('HTTP ')) return 'http';
  return 'unknown';
}

export async function probeOllama(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProbeResult> {
  try {
    // Cap the probe so an unreachable-but-routable host can't hang the caller
    // (doctor, the panel's /api/state poll) on the OS TCP timeout.
    const res = await fetchImpl(`${url.replace(/\/+$/, '')}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      return { ok: false, models: [], error: `http ${res.status}` };
    }
    const j = (await res.json()) as { models?: Array<{ name: string }> };
    return { ok: true, models: (j.models ?? []).map((m) => m.name) };
  } catch (e) {
    // Node's fetch wraps network failures as TypeError("fetch failed") with the
    // real ECONNREFUSED/ENOTFOUND code on `cause` — surface that, not the wrapper.
    const cause = (e as { cause?: { code?: string; message?: string } }).cause;
    const msg = cause?.code ?? cause?.message ?? (e instanceof Error ? e.message : String(e));
    return { ok: false, models: [], error: msg };
  }
}
