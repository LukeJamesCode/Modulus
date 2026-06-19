# Modulus

Modulus is "the everyday AI orchestrator": a small, terminal-first AI agent that runs CPU-only (no GPU needed) on hardware as small as a Raspberry Pi 4. It is the everyday-person evolution of an earlier project called Gurney (itself the successor to a homelab agent, ATLAS). Almost nothing is built in — "modules" are drop-in folders that turn it into anything (calendar, tasks, voice, web search, etc.). It talks to you over a Telegram bot AND an integrated local web panel. The LLM backend is Ollama (running qwen3.5 models), which runs as a SEPARATE process and is NOT bundled with Modulus.

## What's New Since 1.0.0

Five feature milestones have landed since the 1.0.0 release. See [CHANGELOG.md](CHANGELOG.md) for the full detail.

- **1.1.0 — Reasoning controls & notifications**: a per-chat `/think`·`/fast` reasoning mode, and a task dispatched from Telegram now pings you back with its result when it finishes.
- **1.2.0 — Agent management**: hire ready-made agents from a catalog, a plain-language Simple/Advanced agent editor, one-request auto-dispatch ("pick the best agent for me"), and full agent CRUD from Telegram.
- **1.3.0 — Proactive scheduling**: natural-language reminders (`/remind`, `/every`), a periodic heartbeat, and standing orders the heartbeat evaluates on its own — all on one cron + time-zone spine.
- **1.4.0 — Memory**: background extraction of durable facts about you, a nightly deterministic "dreaming" consolidation pass, and per-agent memory namespaces so a busy fleet's findings don't flood the main chat.
- **1.5.0 — Declarative skills + security hardening**: **skills** are the *safe tier* of the marketplace — pure-data playbooks (no code) the assistant loads on demand to do multi-step tasks with tools you already have. Manage them with `/skills` on Telegram or the panel's **Modules → Skills** section. Plus module runtime tripwires (network/subprocess/filesystem allowlist enforcement) and panel security hardening.

## Quickstart

### 1. Prerequisites
- Node.js >= 20
- Ollama installed and running separately.

### 2. Install

**Try it instantly — no clone, no build:**
```bash
npx modulus-agent start
```
This downloads Modulus and opens the setup wizard in your browser. Your config and
data live in `~/.modulus/` and persist across runs, so you can re-run `npx
modulus-agent start` anytime. npx is great for a trial; a global install or the
desktop app is the durable path.

**Install globally:**
```bash
npm i -g modulus-agent
modulus start
```

**From source (for development):**
```bash
git clone <repo-url> modulus
cd modulus
npm install
npm run build
modulus start
```

> Modulus's database engine (better-sqlite3) ships prebuilt binaries for current
> Node LTS (20/22) on Windows, macOS, and Linux — including **arm64** (Apple
> Silicon and Raspberry Pi). If your platform/Node has no prebuilt binary and no
> C/C++ toolchain, the CLI prints clear, actionable instructions instead of a raw
> error (or use the Windows desktop app, which bundles its own runtime).

### 3. Set Up & Run
Just start Modulus:
```bash
modulus start
```
On a fresh install this opens your browser to a setup wizard — detect your hardware tier, pull a model, and (optionally) connect a Telegram bot by sending a pairing code from your phone. Telegram is optional: you can skip it and just use the web panel's chat, then add Telegram later from Settings. When you finish, Modulus promotes itself to the full daemon automatically; no terminal step needed.

On a headless box (a Pi, a Proxmox VM), add `--lan` so the panel binds to all interfaces and prints a LAN URL you can open from another device; use `--no-open` to suppress the browser launch. Prefer the terminal? `modulus init` still walks you through the same setup at the command line.

Once configured, `modulus start` connects the Telegram bot (via long-poll) and serves the web panel on `127.0.0.1`, printing the tokenized URL.

### 4. Use It
Chat in the web panel's **Home** tab, or — if you connected a Telegram bot — with your bot on Telegram. 
You can add capabilities from the **Modules → Browse marketplace** section in the panel, or install them from the terminal:
```bash
modulus mod install <name>
```

### 5. Power Mode (Optional)
Point any model profile at a cloud or big-GPU OpenAI-compatible endpoint for frontier-grade answers while keeping the same safety posture. See [docs/power-mode.md](docs/power-mode.md) for more details.

## Hardware Tiers
Setup detects RAM/CPU and suggests a tier. The defaults scale accordingly, but the underlying code is identical across all tiers:
- **Small**: Raspberry Pi 4/5, 4–8GB RAM, chat model `qwen3.5:0.5b`, reasoning off.
- **Standard**: Mini PC, 16GB RAM, chat model `qwen3.5:0.8b`, optional cold reasoning model.
- **Heavy**: 5800H+ or similar, 32GB RAM, warm reasoning model.

## Web Panel
The web panel is served in-process by the daemon, binds to `127.0.0.1` only, and is protected by a bearer token. `modulus start` prints the tokenized panel URL. 
On the first run, the panel shows an onboarding wizard (model pull, optional Telegram, hardware-tier detect).
The panel has four tabs:
- Home (the assistant chat, plus an Agents area for the fleet, runs, and schedules)
- Modules
- Settings
- System

## First-Party Modules
Almost nothing is built in—Modulus uses "modules" for features. The following nine first-party modules are available:
- **modulus-assistant**: Unified everyday assistant: calendar, tasks, reminders, weather, briefings, day-planning.
- **modulus-websearch**: Web search as a safe, read-only tool (DuckDuckGo or self-hosted SearXNG); results SSRF-guarded and framed as untrusted data.
- **modulus-codex**: Escalate hard tasks from the local Qwen models to OpenAI Codex over a ChatGPT subscription (OAuth); the deep-reasoning brain.
- **modulus-openai**: Register OpenAI-compatible chat-completions endpoints as LLM provider aliases (this powers Power Mode).
- **modulus-minimax**: Adds MiniMax as an LLM provider (not OpenAI-compatible).
- **modulus-voice**: Two-way voice for Telegram: outbound replies via Piper TTS, inbound voice-note transcription via whisper.cpp.
- **modulus-browser**: Lets agents drive a real headless browser (navigate/read/click/type/screenshot) with SSRF guards. Heavy: needs Playwright + Chromium; for Standard/Heavy tiers, not a Pi.
- **modulus-discord**: Discord as a second chat surface alongside Telegram (gateway WebSocket, DM-allowlist or per-channel opt-in, button-based confirm prompts).
- **modulus-abilitytest**: Deterministic eval harness for the agent pipeline — a FakeLLM subset (no Ollama, no network) boots a throwaway in-process orchestrator per test and scores tool-selection, delegation, and end-to-end outcomes. Run with `modulus abilitytest`.

*Note: `modulus-browser` and `modulus-discord` ship source only and require their npm dependencies (Playwright / discord.js) to be installed separately before they will load.*

## Marketplace
Modules install from a curated registry (the `modulus-registry` repo) as sha256-pinned tarballs, with a consent screen showing exactly what permissions each module requests. You can browse and install from the panel's **Modules** tab or by running `modulus mod install <name>` in the terminal.

## CLI Commands
The `modulus` CLI (version 1.5.0) provides the following commands:
- `modulus init`
- `modulus start`
- `modulus stop`
- `modulus status`
- `modulus logs`
- `modulus config`
- `modulus models`
- `modulus auth`
- `modulus doctor`
- `modulus update`
- `modulus fresh`
- `modulus abilitytest`
- `modulus mod <list|install|enable|disable|uninstall|reload|create>`

## Running in Docker
`docker-compose.yml` runs Modulus and Ollama as two containers (Ollama is never bundled — see the comments in the compose file for why). Bring it up with `docker compose up -d`; set your Telegram token and allowlist in a `.env` file first (or run `modulus init` once against the `modulus-data` volume).

The Modulus image ships all nine first-party modules, so they appear in the panel's **Modules** tab and `/api/modules` out of the box. Most are ready immediately. The two **heavy** modules — `modulus-browser` (Playwright + Chromium) and `modulus-discord` (discord.js) — download their own npm packages when enabled, which the default hardened container can't do: it runs read-only with `cap_drop: ALL`. To use a heavy module under Docker, install it into the writable `/data/modules` volume (`modulus mod install <name>`) rather than enabling the read-only copy baked into the image.
