# Modulus

Modulus is "the everyday AI orchestrator": a small, terminal-first AI agent that runs CPU-only (no GPU needed) on hardware as small as a Raspberry Pi 4. It is the everyday-person evolution of an earlier project called Gurney (itself the successor to a homelab agent, ATLAS). Almost nothing is built in — "modules" are drop-in folders that turn it into anything (calendar, tasks, voice, web search, etc.). It talks to you over a Telegram bot AND an integrated local web panel. The LLM backend is Ollama (running qwen3.5 models), which runs as a SEPARATE process and is NOT bundled with Modulus.

## Quickstart

### 1. Prerequisites
- Node.js >= 20
- Ollama installed and running separately.

### 2. Install from Source
*(Note: A one-command `npx modulus` install is Planned, but currently you must install from source.)*

```bash
git clone <repo-url> modulus
cd modulus
npm install
npm run build
```
This produces the `modulus` CLI.

### 3. Set Up
Run the initialization command in your terminal:
```bash
modulus init
```
This interactive setup detects your hardware tier, helps pull a model, and takes your Telegram bot token along with your allowed Telegram user ID.

Alternatively, you can run `modulus start` and complete the panel's first-run onboarding wizard in the browser.

### 4. Run
```bash
modulus start
```
This connects the Telegram bot (via long-poll) and serves the web panel on `127.0.0.1`. It prints the tokenized URL for you to open.

### 5. Use It
Chat with your bot on Telegram, or use the Dashboard chat in the web panel. 
You can add capabilities from the **Modules → Browse marketplace** section in the panel, or install them from the terminal:
```bash
modulus mod install <name>
```

### 6. Power Mode (Optional)
Point any model profile at a cloud or big-GPU OpenAI-compatible endpoint for frontier-grade answers while keeping the same safety posture. See [docs/power-mode.md](docs/power-mode.md) for more details.

## Hardware Tiers
`modulus init` detects RAM/CPU and suggests a tier. The defaults scale accordingly, but the underlying code is identical across all tiers:
- **Small**: Raspberry Pi 4/5, 4–8GB RAM, chat model `qwen3.5:0.5b`, reasoning off.
- **Standard**: Mini PC, 16GB RAM, chat model `qwen3.5:0.8b`, optional cold reasoning model.
- **Heavy**: 5800H+ or similar, 32GB RAM, warm reasoning model.

## Web Panel
The web panel is served in-process by the daemon, binds to `127.0.0.1` only, and is protected by a bearer token. `modulus start` prints the tokenized panel URL. 
On the first run, the panel shows an onboarding wizard (Telegram token, model pull, hardware-tier detect).
The panel has five tabs:
- Dashboard (chat)
- Agents
- Modules
- Settings
- System

## First-Party Modules
Almost nothing is built in—Modulus uses "modules" for features. The following eight first-party modules are available:
- **modulus-assistant**: Unified everyday assistant: calendar, tasks, reminders, weather, briefings, day-planning.
- **modulus-websearch**: Web search as a safe, read-only tool (DuckDuckGo or self-hosted SearXNG); results SSRF-guarded and framed as untrusted data.
- **modulus-codex**: Escalate hard tasks from the local Qwen models to OpenAI Codex over a ChatGPT subscription (OAuth); the deep-reasoning brain.
- **modulus-openai**: Register OpenAI-compatible chat-completions endpoints as LLM provider aliases (this powers Power Mode).
- **modulus-minimax**: Adds MiniMax as an LLM provider (not OpenAI-compatible).
- **modulus-voice**: Two-way voice for Telegram: outbound replies via Piper TTS, inbound voice-note transcription via whisper.cpp.
- **modulus-browser**: Lets agents drive a real headless browser (navigate/read/click/type/screenshot) with SSRF guards. Heavy: needs Playwright + Chromium; for Standard/Heavy tiers, not a Pi.
- **modulus-discord**: Discord as a second chat surface alongside Telegram (gateway WebSocket, DM-allowlist or per-channel opt-in, button-based confirm prompts).

*Note: `modulus-browser` and `modulus-discord` ship source only and require their npm dependencies (Playwright / discord.js) to be installed separately before they will load.*

## Marketplace
Modules install from a curated registry (the `modulus-registry` repo) as sha256-pinned tarballs, with a consent screen showing exactly what permissions each module requests. You can browse and install from the panel's **Modules** tab or by running `modulus mod install <name>` in the terminal.

## CLI Commands
The `modulus` CLI (version 1.0.0) provides the following commands:
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
- `modulus mod <list|install|enable|disable|uninstall|reload|create>`
