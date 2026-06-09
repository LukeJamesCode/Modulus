// Tool engine. The LLM produces tool_calls; this module owns the registry
// of tool handlers, permission tiers, and execution.
//
// Phase 1 ships only the auto tier — a tool whose tier is "auto" runs
// without confirmation. The "confirm" tier (Telegram-prompt before running)
// and "owner" tier (admin-only) wire up in Phase 2 alongside the first real
// tools, since core ships zero tools today.

import type { ToolCall, ToolSchema } from './llm.js';
import type { Logger } from '../util/log.js';
import { composeAbort } from '../util/abort.js';

export type ToolPermissionTier = 'auto' | 'confirm' | 'owner';

// Default per-tool execution deadline. A buggy or hung extension handler
// (e.g. a fetch() to an unresponsive upstream) would otherwise pin the user
// queue indefinitely. 15s matches atlas; tools that legitimately need longer
// (TTS synthesis, PDF parsing) override via ToolHandler.timeoutMs.
export const DEFAULT_TOOL_TIMEOUT_MS = 15_000;

export interface ToolContext {
  // Telegram chat id the call originated from (when applicable).
  chatId?: number;
  // Conversation id from storage.
  conversationId?: number;
  // Caller can pass a child logger pre-bound with request fields.
  log: Logger;
  // AbortSignal forwarded to long-running handlers.
  signal?: AbortSignal;
  // Raw user message that triggered this turn. Tools that need to
  // deterministically cross-check small-model parsing (e.g. clock times in
  // calendar_add_event — qwen3.5:2b misconverts "9pm" → ISO ~30% of the time)
  // can regex it for verbatim spans. Don't use for general intent — that's
  // what the model is for.
  userMessage?: string;
}

export interface ToolHandler {
  name: string;
  description: string;
  // JSON Schema for the function's arguments. Forwarded verbatim to the LLM.
  parameters: Record<string, unknown>;
  tier: ToolPermissionTier;
  // Optional: extension that registered this tool. Used for /help grouping.
  extension?: string;
  // Optional per-tool intent filter. Extension-level intent pruning decides
  // whether an extension is in scope at all; this narrows large extensions
  // to just the relevant tools for the user's current message. This keeps
  // Ollama's native tool manifest small enough for CPU-sized tool models and
  // reduces malformed tool-call XML from tiny models.
  intentPattern?: string | RegExp;
  // When true, the orchestrator ships this tool's output to the user verbatim
  // and skips the follow-up LLM call that would normally re-phrase the
  // result. Use it for action tools whose response IS the user-facing
  // confirmation ("Added: …", "Deleted.") — a second LLM round-trip just to
  // paraphrase that costs the same as the action itself on CPU. Default
  // false: tools whose output the model needs to interpret (list/search
  // results, raw payloads) should leave this off so the model can summarise.
  selfReplying?: boolean;
  // Per-tool execution deadline in ms. Falls back to DEFAULT_TOOL_TIMEOUT_MS
  // when unset. Set to 0 or a negative number to disable the timeout (rare —
  // really only needed for explicit long-running operations).
  timeoutMs?: number;
  // Skip schema validation for this tool. Mostly an escape hatch for tools
  // whose `parameters` JSON Schema is hand-written for the LLM and doesn't
  // map cleanly to the small validator below.
  skipValidation?: boolean;
  // Optional one-line preview for the `confirm` tier prompt. When a confirm
  // hook is wired (Telegram Yes/No), this renders the question the user sees
  // before the tool runs — e.g. "Spend a Codex call on: <task>?". Falls back to
  // a generic "Run <name>?" when unset. Kept as a formatter (not a static
  // string) so it can fold the actual arguments into the prompt. Must not
  // throw; the confirm hook guards it but a clean implementation is expected.
  confirmPrompt?: (args: Record<string, unknown>) => string;
  // Optional deterministic auto-router. Given the raw user message, return the
  // arguments to invoke this tool with — or null to decline. When a tool
  // claims a turn this way, the orchestrator forces the call instead of asking
  // the model to choose, so escalation doesn't depend on a small model's
  // judgment. The forced call still runs through the normal execute() path, so
  // the `confirm` tier and `selfReplying` behaviour both apply. Must not throw;
  // the orchestrator guards it but a clean, fast implementation is expected
  // (it runs on every user turn). At most one tool should match a given
  // message; the orchestrator takes the first.
  autoRoute?: (userMessage: string) => Record<string, unknown> | null;
  invoke(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

export interface ToolResult {
  call: ToolCall;
  ok: boolean;
  output: string;
}

export interface ToolRegistry {
  register(handler: ToolHandler): void;
  unregister(name: string): void;
  list(): ToolHandler[];
  get(name: string): ToolHandler | undefined;
  schemas(): ToolSchema[];
  // Filtered view: only return schemas owned by extensions whose name is in
  // the provided set. Used by the orchestrator to prune the per-turn tool
  // manifest based on intent. Tools without an `extension` (i.e. core-owned)
  // are always included so behaviour stays the same when no extensions match.
  schemasFor(extensionNames: ReadonlySet<string>, inputText?: string): ToolSchema[];
  execute(call: ToolCall, ctx: ToolContext): Promise<ToolResult>;
  // Register a callback fired *after* a successful tool run, before the
  // result is returned to the caller. Used by extensions to invalidate
  // fast-cache entries on writes (e.g. add_event → bust the today's-events
  // cache). Multiple listeners per tool name are allowed and called in
  // registration order; exceptions are caught + logged.
  onAfterExecute(toolName: string, listener: AfterExecuteListener): () => void;
}

export type AfterExecuteListener = (
  call: ToolCall,
  result: ToolResult,
  ctx: ToolContext,
) => void | Promise<void>;

export interface RegistryOptions {
  log: Logger;
  // Hook invoked when a "confirm"-tier call arrives. Phase 2+ wires this to
  // a Telegram inline-keyboard prompt; in Phase 1 nothing registers confirm
  // tools so the default rejector never fires in practice.
  confirm?: (
    handler: ToolHandler,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ) => Promise<boolean>;
  // Owner predicate. Returns true when the caller is the bot owner.
  isOwner?: (ctx: ToolContext) => boolean;
  // Default per-tool timeout. Individual handlers can override via
  // ToolHandler.timeoutMs.
  defaultTimeoutMs?: number;
}

export class ToolDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolDeniedError';
  }
}

export class ToolValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolValidationError';
  }
}

export class ToolTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`tool timed out after ${timeoutMs}ms`);
    this.name = 'ToolTimeoutError';
  }
}

export function createToolRegistry(opts: RegistryOptions): ToolRegistry {
  const handlers = new Map<string, ToolHandler>();
  const log = opts.log.child({ mod: 'tools' });
  const defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  const afterExecute = new Map<string, AfterExecuteListener[]>();

  function register(h: ToolHandler): void {
    if (handlers.has(h.name)) {
      throw new Error(`tool '${h.name}' is already registered`);
    }
    handlers.set(h.name, h);
    log.debug('tool registered', { name: h.name, tier: h.tier, extension: h.extension });
  }

  function unregister(name: string): void {
    handlers.delete(name);
    afterExecute.delete(name);
  }

  function list(): ToolHandler[] {
    return [...handlers.values()];
  }

  function get(name: string): ToolHandler | undefined {
    return handlers.get(name);
  }

  function schemas(): ToolSchema[] {
    return [...handlers.values()].map(toSchema);
  }

  function schemasFor(extensionNames: ReadonlySet<string>, inputText?: string): ToolSchema[] {
    const inScope = [...handlers.values()].filter(
      (h) => !h.extension || extensionNames.has(h.extension),
    );
    if (!inputText) return inScope.map(toSchema);

    const grouped = new Map<string, ToolHandler[]>();
    const core: ToolHandler[] = [];
    for (const h of inScope) {
      if (!h.extension) {
        core.push(h);
        continue;
      }
      const arr = grouped.get(h.extension) ?? [];
      arr.push(h);
      grouped.set(h.extension, arr);
    }

    const filtered = [...core];
    for (const group of grouped.values()) {
      const narrowed = group.filter((h) => matchesToolIntent(h, inputText));
      // Safety fallback: if the extension-level pattern matched but no
      // per-tool pattern did, expose the whole extension rather than silently
      // disabling a valid request.
      filtered.push(...(narrowed.length > 0 ? narrowed : group));
    }
    return filtered.map(toSchema);
  }

  function onAfterExecute(toolName: string, listener: AfterExecuteListener): () => void {
    const arr = afterExecute.get(toolName) ?? [];
    arr.push(listener);
    afterExecute.set(toolName, arr);
    return () => {
      const cur = afterExecute.get(toolName);
      if (!cur) return;
      const idx = cur.indexOf(listener);
      if (idx >= 0) cur.splice(idx, 1);
    };
  }

  async function execute(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const h = handlers.get(call.name);
    if (!h) {
      return { call, ok: false, output: `unknown tool '${call.name}'` };
    }
    try {
      if (h.tier === 'owner') {
        if (!opts.isOwner?.(ctx)) {
          throw new ToolDeniedError(`tool '${h.name}' is owner-only`);
        }
      } else if (h.tier === 'confirm') {
        const ok = opts.confirm ? await opts.confirm(h, call.arguments, ctx) : false;
        if (!ok) throw new ToolDeniedError(`tool '${h.name}' was not confirmed`);
      }

      // Argument validation. Small-model tool calls regularly arrive with
      // wrong types ("date":"tomorrow" instead of ISO) or missing required
      // keys. Returning a structured error to the LLM lets the next round
      // self-correct, which on a 0.8b model is far more reliable than
      // letting the handler explode partway through with an opaque message.
      if (!h.skipValidation) {
        const errs = validateArgs(call.arguments, h.parameters);
        if (errs.length > 0) {
          throw new ToolValidationError(`invalid arguments for '${h.name}': ${errs.join('; ')}`);
        }
      }

      // Compose the caller's signal with a per-tool timeout. AbortSignal.any
      // (Node 20.3+) gives us "abort when any input aborts" without manual
      // wiring. Tools that need to opt out can set timeoutMs to a non-positive
      // value — handy for known long-running ops (TTS synthesis, big PDFs).
      const toolTimeout = h.timeoutMs ?? defaultTimeoutMs;
      let timer: NodeJS.Timeout | null = null;
      let timedOut = false;
      let signal: AbortSignal | undefined = ctx.signal;
      
      let timeoutReject: ((err: Error) => void) | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutReject = reject;
      });

      if (toolTimeout > 0) {
        const tctl = new AbortController();
        timer = setTimeout(() => {
          timedOut = true;
          const err = new ToolTimeoutError(toolTimeout);
          tctl.abort(err);
          timeoutReject?.(err);
        }, toolTimeout);
        signal = ctx.signal ? composeAbort(ctx.signal, tctl.signal) : tctl.signal;
      }
      const childCtx: ToolContext = { ...ctx, ...(signal ? { signal } : {}) };

      try {
        // The timeout can win this race, leaving h.invoke() still pending. A
        // tool that ignores the abort signal AND later rejects would then throw
        // with no handler attached → unhandledRejection (fatal on the daemon).
        // Attach a terminal no-op catch so a late loser-rejection is swallowed.
        const invocation = h.invoke(call.arguments, childCtx);
        invocation.catch(() => {});
        const output = await Promise.race([
          invocation,
          ...(toolTimeout > 0 ? [timeoutPromise] : []),
        ]);
        const result: ToolResult = { call, ok: true, output };
        const listeners = afterExecute.get(call.name);
        if (listeners && listeners.length > 0) {
          for (const fn of listeners) {
            try {
              await fn(call, result, ctx);
            } catch (e) {
              log.warn('afterExecute listener failed', {
                tool: call.name,
                error: e instanceof Error ? e.message : String(e),
              });
            }
          }
        }
        return result;
      } catch (e) {
        if (timedOut) {
          throw new ToolTimeoutError(toolTimeout);
        }
        throw e;
      } finally {
        if (timer) clearTimeout(timer);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warn('tool failed', { name: call.name, error: msg });
      return { call, ok: false, output: msg };
    }
  }

  return {
    register,
    unregister,
    list,
    get,
    schemas,
    schemasFor,
    execute,
    onAfterExecute,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Tiny JSON-schema validator. Matches what extensions actually write in
// their `parameters` blocks — type, properties, required, enum, items —
// without dragging in ajv (~150KB). Returns a list of human-readable
// error strings; empty array means valid. The model then sees these
// strings via the tool result and self-corrects on the next round.
export function validateArgs(args: unknown, schema: Record<string, unknown> | undefined): string[] {
  if (!schema || typeof schema !== 'object') return [];
  const errs: string[] = [];
  validate(args, schema, '', errs, 0);
  return errs;
}

// Depth-bound: a malicious extension schema with circular refs or 10k+
// nested arrays would otherwise blow the stack. 32 is far deeper than any
// legitimate tool schema needs.
const MAX_VALIDATION_DEPTH = 32;

function validate(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
  errs: string[],
  depth: number,
): void {
  if (depth > MAX_VALIDATION_DEPTH) {
    errs.push(`${path || '<root>'}: schema too deep (>${MAX_VALIDATION_DEPTH})`);
    return;
  }
  const type = schema['type'] as string | string[] | undefined;
  if (type) {
    const types = Array.isArray(type) ? type : [type];
    if (!types.some((t) => matchesType(value, t))) {
      errs.push(`${path || '<root>'}: expected ${types.join('|')}, got ${typeName(value)}`);
      return;
    }
  }
  const enumVals = schema['enum'] as unknown[] | undefined;
  if (enumVals && !enumVals.some((v) => deepEqual(v, value))) {
    errs.push(
      `${path || '<root>'}: value not in enum [${enumVals.map((v) => JSON.stringify(v)).join(', ')}]`,
    );
  }
  if (Array.isArray(value) && schema['items']) {
    const itemSchema = schema['items'] as Record<string, unknown>;
    for (let i = 0; i < value.length; i++) {
      validate(value[i], itemSchema, `${path}[${i}]`, errs, depth + 1);
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const props = (schema['properties'] as Record<string, Record<string, unknown>>) || {};
    const required = (schema['required'] as string[]) || [];
    for (const key of required) {
      if (!(key in obj)) {
        errs.push(`${path || '<root>'}: missing required property '${key}'`);
      }
    }
    for (const [key, subSchema] of Object.entries(props)) {
      if (key in obj) {
        validate(obj[key], subSchema, path ? `${path}.${key}` : key, errs, depth + 1);
      }
    }
  }
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && !Number.isNaN(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return !!value && typeof value === 'object' && !Array.isArray(value);
    case 'null':
      return value === null;
    default:
      return true;
  }
}

function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === 'object') {
    const aa = a as Record<string, unknown>;
    const bb = b as Record<string, unknown>;
    const ka = Object.keys(aa);
    const kb = Object.keys(bb);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEqual(aa[k], bb[k]));
  }
  return false;
}

export function toSchema(h: ToolHandler): ToolSchema {
  return {
    type: 'function',
    function: {
      name: h.name,
      description: h.description,
      parameters: h.parameters,
    },
  };
}

function matchesToolIntent(h: ToolHandler, inputText: string): boolean {
  if (!h.intentPattern) return true;
  if (typeof h.intentPattern === 'string') {
    try {
      return new RegExp(h.intentPattern, 'i').test(inputText);
    } catch {
      // Bad extension metadata should not make the tool disappear at runtime.
      return true;
    }
  }
  h.intentPattern.lastIndex = 0;
  return h.intentPattern.test(inputText);
}
