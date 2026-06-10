// Best-effort "open the wizard in the user's browser". Used only when entering
// setup mode (configured daily starts keep print-only behaviour). The URL is
// always passed as a single argv element — never shell-interpolated — so a
// tokenized URL with `&`/`?` can't be misparsed or injected.

import { spawn } from 'node:child_process';

export function openBrowser(url: string): boolean {
  try {
    if (process.platform === 'win32') {
      // rundll32's FileProtocolHandler opens the default browser without the
      // `cmd /c start` quoting pitfalls (start treats the first quoted arg as a
      // window title, and `&` in a tokenized URL breaks unquoted).
      spawn('rundll32', ['url.dll,FileProtocolHandler', url], {
        detached: true,
        stdio: 'ignore',
      }).unref();
      return true;
    }
    if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
      return true;
    }
    // Linux/other: only attempt when a graphical session exists, otherwise
    // xdg-open just errors (or worse, blocks) on a headless box.
    if (!process.env['DISPLAY'] && !process.env['WAYLAND_DISPLAY']) return false;
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch {
    return false;
  }
}
