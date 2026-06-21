# Deployment topologies

Modulus is one always-on process (the **engine**: Telegram bot + agent engine +
web panel + scheduler) plus the surface you talk to (the web panel in a browser,
or the desktop app). Ollama is the only separate process. These pieces can all
live on one device or be split across several. The first-run setup wizard asks
which layout you want; nothing here is locked in — change it later in **Settings →
Network access** (engine side) or the desktop app's tray **Connection…** item
(frontend side).

## The choices

| Topology | Engine | Ollama | Panel bind |
| --- | --- | --- | --- |
| **Just this device** | local | local | `127.0.0.1` (loopback) |
| **Ollama on another device** | local | remote (set the Ollama URL) | `127.0.0.1` |
| **Host for my other devices** | local, LAN-exposed | local *or* remote | `0.0.0.0` |
| **Frontend only** (desktop app) | remote — you connect to one of the above | — | — |

The only config knob that differs between the first three is `panel.bind`
(`config.json` → `panel.bind`, or `MODULUS_PANEL_BIND`). "Host for my other
devices" flips it to `0.0.0.0` so other devices — and the desktop app's
"connect to a remote Modulus" mode — can reach it. The Ollama URL
(`ollama.url` / `OLLAMA_URL`) is independent and can point anywhere on any
topology, so "host for other devices **and** Ollama on a third box" is just the
host topology with a remote Ollama URL.

## Mini PC backend + desktop frontend (the always-on setup)

Goal: the engine runs on an always-on mini PC (e.g. a Proxmox CT), Ollama runs on
another CT, and your desktop app is a thin frontend that keeps working when the
desktop is off.

1. **Ollama CT** — run Ollama with `OLLAMA_HOST=0.0.0.0` so the engine CT can reach
   it. Pull your chat model there.
2. **Engine CT** — install Modulus and run `modulus start --lan` (or finish the web
   wizard, pick **Host for my other devices**, and set the Ollama URL to the Ollama
   CT, e.g. `http://10.0.0.21:11434`). `--lan` / the host topology binds the panel
   to `0.0.0.0`. It is **token-gated** — anyone on the network with the link can
   control it, so keep the link private.
3. **Get the connect link** — at boot the engine prints
   `Panel: http://<engine-ip>:<port>/?token=…`. The same link is shown in the panel
   under **System → Connect from another device** (copy button). This single link
   carries the host, port, and secret token.
4. **Desktop app** — on first launch (or tray → **Connection…**) choose **Connect to
   a Modulus running elsewhere** and paste the link. The app validates it, then
   loads that remote panel. Closing or quitting the desktop app **does not** stop
   the engine — it keeps running on the mini PC; a dropped network link reconnects
   automatically.

## Security notes

- The panel is bound to `127.0.0.1` by default. LAN exposure (`0.0.0.0`) is always
  an explicit opt-in and is announced loudly in the log on boot.
- Auth is the per-install bearer token in `~/.modulus/panel-token` plus per-IP
  attempt backoff. To rotate it, delete that file and restart — the old link stops
  working.
- The desktop app stores its frontend choice (local vs the remote link) in
  `%LOCALAPPDATA%\Modulus\desktop.json`, separate from the engine's `~/.modulus`.
