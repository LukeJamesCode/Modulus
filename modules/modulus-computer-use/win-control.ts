// Desktop control backend. The OS-agnostic ControlBackend interface is what the
// session loop drives; the Windows implementation shells a sibling PowerShell
// script that uses built-in .NET (System.Drawing for capture, user32 P-Invoke
// for input). This keeps the whole capability TOOLCHAIN-FREE — no native npm
// addon to compile, which is the only thing that makes it viable on a box
// without a C++ compiler. A mac-control.ts / x11-control.ts can implement the
// same interface later without the session loop changing.
//
// Coordinates are primary-monitor pixels (origin top-left). Multi-monitor is a
// deliberate v1 omission so the model's click coordinates map 1:1 to the screen
// it was shown.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export interface Screenshot {
  // PNG bytes, base64, no `data:` prefix — ready to drop into ChatMessage.images.
  base64: string;
  // Absolute path to the saved PNG (the per-step audit artifact + panel preview).
  path: string;
  width: number;
  height: number;
}

export interface ForegroundWindow {
  // Lowercased process name without a trailing .exe (e.g. "notepad", "chrome").
  process: string;
  title: string;
}

export type MouseButton = 'left' | 'right' | 'double';

export interface ControlBackend {
  // Capture the primary screen to `savePath` and return it base64-encoded.
  capture(savePath: string): Promise<Screenshot>;
  foreground(): Promise<ForegroundWindow>;
  click(x: number, y: number, button?: MouseButton): Promise<void>;
  type(text: string): Promise<void>;
  // A friendly combo like "ctrl+s", "enter", "alt+f4", "ctrl+shift+escape".
  key(combo: string): Promise<void>;
  // Wheel ticks: positive dy scrolls up, negative scrolls down.
  scroll(dx: number, dy: number): Promise<void>;
  drag(fromX: number, fromY: number, toX: number, toY: number): Promise<void>;
}

// Minimal structural view of a spawned child — only what runPs touches. Defined
// locally rather than imported from node:child_process so this module reaches
// subprocesses ONLY through the injected host.spawn (the tripwire-enforced
// gateway), per the "subprocess goes through host.spawn" rule.
interface SpawnedChild {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'close', listener: (code: number | null) => void): unknown;
  kill(): unknown;
}

// Spawn gateway: the module's tripwire-enforced host.spawn in production, or a
// stub in a unit test. Structurally compatible with host.spawn.
export type SpawnFn = (
  command: string,
  args?: readonly string[],
  options?: { stdio?: ReadonlyArray<'ignore' | 'pipe' | 'inherit'> },
) => SpawnedChild;

const PS1_PATH = fileURLToPath(new URL('./win-control.ps1', import.meta.url));

// ---------------------------------------------------------------------------
// Key-combo translation (pure — unit tested). Friendly combo -> SendKeys.
// ---------------------------------------------------------------------------

const NAMED_KEYS: Record<string, string> = {
  enter: '{ENTER}',
  return: '{ENTER}',
  tab: '{TAB}',
  esc: '{ESC}',
  escape: '{ESC}',
  space: ' ',
  backspace: '{BACKSPACE}',
  delete: '{DELETE}',
  del: '{DELETE}',
  insert: '{INSERT}',
  home: '{HOME}',
  end: '{END}',
  pageup: '{PGUP}',
  pagedown: '{PGDN}',
  pgup: '{PGUP}',
  pgdn: '{PGDN}',
  up: '{UP}',
  down: '{DOWN}',
  left: '{LEFT}',
  right: '{RIGHT}',
};

for (let i = 1; i <= 12; i++) NAMED_KEYS[`f${i}`] = `{F${i}}`;

const MODIFIERS: Record<string, string> = { ctrl: '^', control: '^', alt: '%', shift: '+' };

// Translate "ctrl+shift+s" / "alt+f4" / "enter" into a SendKeys string. Throws
// a clear error for unsupported keys (notably the Windows key, which SendKeys
// can't emit) so the loop records a precise failure instead of a silent no-op.
export function comboToSendKeys(combo: string): string {
  const parts = combo
    .split('+')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 0) throw new Error('empty key combo');

  let mods = '';
  const keys: string[] = [];
  for (const part of parts) {
    if (part in MODIFIERS) {
      mods += MODIFIERS[part];
      continue;
    }
    if (part === 'win' || part === 'super' || part === 'meta') {
      throw new Error('the Windows key is not supported by this backend');
    }
    if (part in NAMED_KEYS) {
      keys.push(NAMED_KEYS[part]!);
    } else if (part.length === 1) {
      // SendKeys treats + ^ % ~ ( ) { } [ ] as control chars; brace-escape them.
      keys.push(/[+^%~(){}[\]]/.test(part) ? `{${part}}` : part);
    } else {
      throw new Error(`unsupported key: ${part}`);
    }
  }
  if (keys.length === 0) throw new Error(`key combo has only modifiers: ${combo}`);
  // One non-modifier key wrapped by its modifiers — covers virtually every
  // shortcut; multi-key chords aren't expressible to a vision model anyway.
  return `${mods}${keys.join('')}`;
}

// ---------------------------------------------------------------------------
// Windows backend
// ---------------------------------------------------------------------------

function runPs(spawnFn: SpawnFn, args: string[], timeoutMs = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let child: SpawnedChild;
    try {
      child = spawnFn(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS1_PATH, ...args],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`powershell ${args[0]} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.stderr?.on('data', (d: Buffer) => (err += d.toString('utf8')));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(err.trim() || `powershell ${args[0]} exited with code ${code}`));
    });
  });
}

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

export function createWindowsBackend(spawnFn: SpawnFn): ControlBackend {
  return {
    async capture(savePath) {
      const out = (await runPs(spawnFn, ['capture', savePath])).trim();
      const [w, h] = out.split(/\s+/).map((n) => Number.parseInt(n, 10));
      const bytes = await readFile(savePath);
      return {
        base64: bytes.toString('base64'),
        path: savePath,
        width: Number.isFinite(w) ? (w as number) : 0,
        height: Number.isFinite(h) ? (h as number) : 0,
      };
    },
    async foreground() {
      const out = (await runPs(spawnFn, ['foreground'])).trim();
      try {
        const parsed = JSON.parse(out) as { process?: string; title?: string };
        return {
          process: String(parsed.process ?? '').toLowerCase(),
          title: String(parsed.title ?? ''),
        };
      } catch {
        return { process: '', title: '' };
      }
    },
    async click(x, y, button = 'left') {
      await runPs(spawnFn, ['click', String(Math.round(x)), String(Math.round(y)), button]);
    },
    async type(text) {
      await runPs(spawnFn, ['type', b64(text)]);
    },
    async key(combo) {
      // Translate here so an unsupported key fails fast with a clear message
      // (and is unit-testable) before we ever shell out.
      await runPs(spawnFn, ['key', b64(comboToSendKeys(combo))]);
    },
    async scroll(dx, dy) {
      await runPs(spawnFn, ['scroll', String(Math.round(dx)), String(Math.round(dy))]);
    },
    async drag(fromX, fromY, toX, toY) {
      await runPs(spawnFn, [
        'drag',
        String(Math.round(fromX)),
        String(Math.round(fromY)),
        String(Math.round(toX)),
        String(Math.round(toY)),
      ]);
    },
  };
}
