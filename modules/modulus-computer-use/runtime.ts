// Shared runtime for the module's entrypoints. tools.ts and commands.ts are
// separate files (separate module scopes), but both must drive the SAME live
// session so "/computer stop" halts a tool-started run and vice versa. A lazy
// per-load singleton built from the host gives them one SessionManager, one
// config reader, and one Telegram step-streamer. A reload re-imports fresh, so
// the singleton resets with it.

import type { Host } from '../../src/core/modules.js';
import { createWindowsBackend, type SpawnFn } from './win-control.js';
import { createVision } from './vision.js';
import {
  createSessionManager,
  type SessionConfig,
  type SessionEvent,
  type SessionManager,
} from './session.js';

export interface Runtime {
  manager: SessionManager;
  getConfig: () => SessionConfig;
  // sessionId -> originating chat, so step events stream to the right chat.
  sessionChat: Map<number, number>;
  describeScreen: (savePath: string) => Promise<string>;
  captureToPath: (savePath: string) => Promise<{ width: number; height: number; path: string }>;
}

let singleton: Runtime | null = null;

function statusLine(ev: SessionEvent): string {
  switch (ev.status) {
    case 'running':
      return `▶ Computer use started: ${ev.detail ?? ''}`.trim();
    case 'done':
      return `✅ Done: ${ev.detail ?? ''}`.trim();
    case 'stopped':
      return `⏹ Stopped. ${ev.detail ?? ''}`.trim();
    case 'paused':
      return `⏸ ${ev.detail ?? 'Paused.'}`.trim();
    case 'error':
      return `⚠ Error: ${ev.detail ?? ''}`.trim();
    default:
      return ev.detail ?? '';
  }
}

export function getRuntime(host: Host): Runtime {
  if (singleton) return singleton;

  // host.spawn is the tripwire-enforced gateway; its ChildProcess return is a
  // superset of the backend's minimal SpawnedChild contract.
  const backend = createWindowsBackend(host.spawn as unknown as SpawnFn);
  const vision = createVision({ llm: host.llm, fetch: host.fetch });
  const sessionChat = new Map<number, number>();

  function getConfig(): SessionConfig {
    const s = host.settings;
    const allowRaw = String(s.get('app_allowlist', '') ?? '');
    const appAllowlist = allowRaw
      .split(',')
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean);
    const backendName = String(s.get('vision_backend', 'local')) === 'cloud' ? 'cloud' : 'local';
    return {
      vision: {
        backend: backendName,
        localModel: String(s.get('vision_model', 'qwen2.5vl:7b')),
        cloudEndpoint: String(s.get('cloud_endpoint', 'https://api.anthropic.com/v1/messages')),
        cloudModel: String(s.get('cloud_model', 'claude-sonnet-4-5')),
        cloudApiKey: String(s.get('cloud_api_key', '')),
      },
      appAllowlist,
      maxSteps: Math.max(1, Number(s.get('max_steps', 40)) || 40),
      stepDelayMs: Math.max(0, Number(s.get('step_delay_ms', 600)) || 600),
    };
  }

  // Stream each step to the originating Telegram chat (the panel tails the DB
  // separately, so it needs nothing here). Best-effort — a gone surface throws.
  async function emit(ev: SessionEvent): Promise<void> {
    const chatId = ev.sessionId !== undefined ? sessionChat.get(ev.sessionId) : undefined;
    if (chatId === undefined) return;
    try {
      if (ev.type === 'step' && ev.screenshot) {
        const tag = ev.outcome && ev.outcome !== 'ok' ? ` [${ev.outcome}]` : '';
        const reason = ev.rationale ? ` — ${ev.rationale}` : '';
        const extra = ev.detail ? ` (${ev.detail})` : '';
        const caption = `#${ev.stepNo} ${ev.action}${tag}${reason}${extra}`.slice(0, 1000);
        await host.telegram.sendPhoto(chatId, { path: ev.screenshot, caption });
      } else {
        const text =
          ev.type === 'status'
            ? statusLine(ev)
            : `#${ev.stepNo} ${ev.action} [${ev.outcome}]${ev.detail ? ` ${ev.detail}` : ''}`;
        if (text) await host.telegram.sendMessage(chatId, text);
      }
    } catch {
      /* surface disconnected mid-run; the loop keeps going */
    }
  }

  const manager = createSessionManager(
    {
      db: host.db,
      backend,
      vision,
      log: host.log,
      dataDir: host.dataDir,
      emit,
      // v1: sensitive actions fail closed (the loop pauses for manual handling).
      // Interactive approval from a surface is a follow-up.
    },
    getConfig,
  );

  async function captureToPath(savePath: string): Promise<{ width: number; height: number; path: string }> {
    const shot = await backend.capture(savePath);
    return { width: shot.width, height: shot.height, path: shot.path };
  }

  async function describeScreen(savePath: string): Promise<string> {
    const shot = await backend.capture(savePath);
    return vision.describe(getConfig().vision, {
      goal: '',
      screenshotB64: shot.base64,
      width: shot.width,
      height: shot.height,
      history: [],
    });
  }

  singleton = { manager, getConfig, sessionChat, describeScreen, captureToPath };
  return singleton;
}
