// Telegram pairing manager. The setup wizard needs a friendlier path to the
// allowlist than "go find your numeric user id": the user pastes a bot token,
// we hand them a short code, they send it to the bot from their phone, and we
// capture their user id from the incoming message.
//
// Two transports drive the same matcher:
//   - Setup mode (no daemon, no grammY poller): a raw long-poll getUpdates loop
//     lives here. It's conflict-free because nothing else is consuming updates.
//   - Full mode (Step 7): the live grammY adapter already owns the only
//     getUpdates consumer, so a second one would get HTTP 409. Instead the
//     adapter's allowlist-reject middleware calls tryMatch() for each rejected
//     private message — same matcher, different transport.
//
// State is in-memory and single-session: a new start() cancels any prior one
// (mirrors the panel's one-auth-session-per-module rule). The wizard accumulates
// paired ids in its own draft and writes them all via POST /api/config.

import type { DB } from '../storage/db.js';
import type { Logger } from '../util/log.js';

export type PairingState = 'idle' | 'waiting' | 'paired' | 'expired' | 'error';

export interface PairingStatus {
  state: PairingState;
  code: string | null;
  botUser?: string;
  botName?: string;
  userId?: number;
  firstName?: string;
  error?: string;
  expiresAt?: number;
}

export interface PairingStartResult {
  ok: boolean;
  code?: string;
  botUser?: string;
  botName?: string;
  expiresAt?: number;
  error?: string;
}

export interface PairingManager {
  start(token: string): Promise<PairingStartResult>;
  status(): PairingStatus;
  stop(): void;
  // Full-mode transport: the adapter passes each rejected (non-allowlisted)
  // private message here. Returns true when it matched the active code and was
  // consumed (the caller should swallow the message and reply itself).
  tryMatch(text: string, from: { id: number; first_name?: string }, chatId: number): boolean;
}

export interface PairingManagerOptions {
  db: DB;
  log: Logger;
  apiBase?: string;
  fetchImpl?: typeof fetch;
  // Pairing-code lifetime. After this the session expires and the loop stops.
  ttlMs?: number;
  // Whether start() should run its own getUpdates long-poll. True (default) in
  // setup mode where nothing else polls. MUST be false in full mode, where the
  // live grammY adapter owns the only getUpdates consumer — a second one gets a
  // 409. Full mode drives pairing through tryMatch() instead.
  pollUpdates?: boolean;
}

// Unambiguous alphabet: no I/O/0/1, so a code read off one screen and typed on a
// phone can't be misread. 4 chars over 32 symbols = ~1M codes — plenty for a
// single live session that also expires in minutes.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 4;
const DEFAULT_TTL_MS = 10 * 60_000;

function generateCode(): string {
  let out = 'MOD-';
  for (let i = 0; i < CODE_LEN; i++) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
}

interface Session {
  token: string;
  code: string;
  botUser: string;
  botName: string;
  expiresAt: number;
  // The AbortController for the live getUpdates loop (setup mode only). Absent
  // in full mode, where the adapter drives tryMatch instead.
  abort: AbortController | null;
  expiryTimer: ReturnType<typeof setTimeout> | null;
}

export function createPairingManager(opts: PairingManagerOptions): PairingManager {
  const log = opts.log.child({ mod: 'pairing' });
  const apiBase = (opts.apiBase ?? 'https://api.telegram.org').replace(/\/+$/, '');
  const fetchImpl = opts.fetchImpl ?? fetch;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const pollUpdates = opts.pollUpdates ?? true;

  let session: Session | null = null;
  let status: PairingStatus = { state: 'idle', code: null };

  function api(token: string, method: string): string {
    return `${apiBase}/bot${token}/${method}`;
  }

  function clearSession(): void {
    if (session?.abort) session.abort.abort();
    if (session?.expiryTimer) clearTimeout(session.expiryTimer);
    session = null;
  }

  function stop(): void {
    clearSession();
    if (status.state === 'waiting') status = { state: 'idle', code: null };
  }

  // The shared matcher half: record the paired user, flip state. The transport
  // (loop vs adapter) is responsible for the user-facing confirmation reply.
  function connect(from: { id: number; first_name?: string }, chatId: number): void {
    const s = session;
    if (!s) return;
    // First-boot ownerChat / nudges resolve a chat from telegram_chats; seed it
    // now so a freshly-paired user can receive proactive messages immediately.
    try {
      opts.db
        .prepare(
          `INSERT INTO telegram_chats (chat_id, user_id, last_seen_at)
           VALUES (?, ?, ?)
           ON CONFLICT(chat_id) DO UPDATE SET user_id = excluded.user_id,
                                              last_seen_at = excluded.last_seen_at`,
        )
        .run(chatId, from.id, Date.now());
    } catch (e) {
      log.warn('pairing telegram_chats upsert failed', {
        error: e instanceof Error ? e.message : String(e),
      });
    }
    status = {
      state: 'paired',
      code: s.code,
      botUser: s.botUser,
      botName: s.botName,
      userId: from.id,
      ...(from.first_name ? { firstName: from.first_name } : {}),
    };
    if (s.expiryTimer) clearTimeout(s.expiryTimer);
    if (s.abort) s.abort.abort();
    session = null;
    log.info('telegram pairing matched', { userId: from.id });
  }

  function codeMatches(text: string): boolean {
    return !!session && text.trim().toUpperCase() === session.code;
  }

  function tryMatch(
    text: string,
    from: { id: number; first_name?: string },
    chatId: number,
  ): boolean {
    if (!codeMatches(text)) return false;
    connect(from, chatId);
    return true;
  }

  // Setup-mode long-poll. Conflict-free because no grammY poller exists yet.
  async function runLoop(s: Session): Promise<void> {
    let offset = 0;
    while (session === s && !s.abort?.signal.aborted) {
      let res: Response;
      try {
        const url =
          api(s.token, 'getUpdates') +
          `?timeout=25&offset=${offset}&allowed_updates=${encodeURIComponent('["message"]')}`;
        res = await fetchImpl(url, { signal: s.abort?.signal });
      } catch (e) {
        if (s.abort?.signal.aborted) return; // stop()/expiry aborted us
        // A transient network blip — pause briefly, then retry.
        log.warn('pairing getUpdates failed', {
          error: e instanceof Error ? e.message : String(e),
        });
        await delay(2000, s.abort?.signal);
        continue;
      }
      if (res.status === 409) {
        // Another consumer is polling this bot (e.g. a running daemon). Surface
        // it so the wizard can tell the user to stop the other process.
        status = {
          state: 'error',
          code: s.code,
          error: 'Another program is polling this bot — stop it and try again.',
        };
        clearSession();
        return;
      }
      if (!res.ok) {
        await delay(2000, s.abort?.signal);
        continue;
      }
      let body: TelegramUpdatesResponse;
      try {
        body = (await res.json()) as TelegramUpdatesResponse;
      } catch {
        continue;
      }
      for (const update of body.result ?? []) {
        // Always advance past every update — matching or not — so a stale
        // message can never spin the loop.
        if (update.update_id >= offset) offset = update.update_id + 1;
        const msg = update.message;
        if (!msg || msg.chat?.type !== 'private' || typeof msg.text !== 'string') continue;
        if (!msg.from || !codeMatches(msg.text)) continue;
        const from = msg.from;
        const chatId = msg.chat.id;
        connect(
          { id: from.id, ...(from.first_name ? { first_name: from.first_name } : {}) },
          chatId,
        );
        // Best-effort confirmation so the user sees it worked on their phone.
        void fetchImpl(api(s.token, 'sendMessage'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: "✅ You're connected to Modulus." }),
        }).catch(() => {});
        return;
      }
    }
  }

  async function start(token: string): Promise<PairingStartResult> {
    clearSession();
    status = { state: 'idle', code: null };
    // getMe both validates the token live and gives us the bot's @username for
    // the deep-link button the wizard renders.
    let botUser = '';
    let botName = 'Modulus';
    try {
      const res = await fetchImpl(api(token, 'getMe'));
      const j = (await res.json()) as {
        ok?: boolean;
        result?: { first_name?: string; username?: string };
      };
      if (!j.ok || !j.result) return { ok: false, error: 'Telegram rejected that token.' };
      botName = j.result.first_name ?? 'Modulus';
      botUser = j.result.username ? `@${j.result.username}` : '';
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }

    const code = generateCode();
    const expiresAt = Date.now() + ttlMs;
    const abort = new AbortController();
    const s: Session = { token, code, botUser, botName, expiresAt, abort, expiryTimer: null };
    s.expiryTimer = setTimeout(() => {
      if (session === s) {
        status = { state: 'expired', code: s.code };
        clearSession();
      }
    }, ttlMs);
    s.expiryTimer.unref?.();
    session = s;
    status = { state: 'waiting', code, botUser, botName, expiresAt };
    // Setup mode only: fire the long-poll (bounded by the abort signal + expiry
    // timer). Full mode skips it and matches via tryMatch from the adapter.
    if (pollUpdates) void runLoop(s);
    return { ok: true, code, botUser, botName, expiresAt };
  }

  return {
    start,
    status: () => status,
    stop,
    tryMatch,
  };
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });
}

interface TelegramUpdatesResponse {
  ok?: boolean;
  result?: Array<{
    update_id: number;
    message?: {
      text?: string;
      chat?: { id: number; type?: string };
      from?: { id: number; first_name?: string };
    };
  }>;
}
