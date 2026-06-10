# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Live ability scorecard** (`modulus abilitytest --live`): runs the same ability catalog against the real configured model(s) instead of the deterministic FakeLLM, measuring actual tool-selection and delegation judgement. Scores up to two profiles side by side — the local Ollama small model (the Pi profile) and Power Mode when an OpenAI-compatible endpoint is configured — and leads with a per-dimension scorecard. Refuses while a daemon is running (to avoid contending over the DB and heavy-model slot) and writes to `~/.modulus/ability-live-<ts>.md`, a distinct prefix that keeps live runs out of the `--fails` re-run scan.
- **Heavy-module dependency bootstrap**: `modulus-browser` and `modulus-discord` now install their npm deps into their own folder on enable (via a `setup` entrypoint), so core no longer carries them. Browser fetches the `playwright` package plus a Chromium binary; Discord fetches `discord.js` + `@discordjs/voice` (both import-time deps the bridge needs to boot). A shared `ensureNpmDeps` helper skips anything already resolvable, so re-enabling is a fast no-op.

### Changed

- **Core stays Pi-lean**: removed `discord.js` from core `dependencies` — it's now installed only when `modulus-discord` is enabled, honoring the "heavy is opt-in, never core" North Star.

## [1.0.0] - 2026-06-10

### Added

- **Core engine**: A single Node process running two in-process queues (user-facing and background). Features SQLite storage with numbered migrations and a deterministic prompt prefix (system → tools → memory → session → history) for Ollama slot-cache reuse. Powers a multi-agent engine with an autonomous loop and a delegating fleet. Includes hive-mind long-term memory shared across agents (using SQLite FTS5/BM25 recall), a scheduler for proactive nudges and quiet-hours, and a resource governor that handles heavy-model eviction. Implements tool tiers (auto vs confirm) where confirm-tier tools fail closed in unattended runs, alongside secret redaction in logs.
- **Chat surfaces**: A Telegram bot using long-polling, and an integrated, in-process web panel bound to localhost behind a bearer token. The panel includes five tabs: Dashboard (chat), Agents, Modules, Settings, and System, plus a first-run onboarding wizard for capturing the Telegram token, pulling a model, and detecting hardware tiers.
- **Instant Responses**: Instant canned acknowledgements provided for turns that are predicted to be slow, requiring no extra model call, available on both Telegram and the web panel.
- **Modules**: A manifest v2 format with honest permission blocks and module-provided specialist agents. Ships with eight first-party modules (`modulus-assistant`, `modulus-websearch`, `modulus-codex`, `modulus-openai`, `modulus-minimax`, `modulus-voice`, `modulus-browser`, and `modulus-discord`). Includes a curated, sha256-pinned marketplace with consent and re-consent flows on permission growth, and a `modulus mod` CLI for listing, installing, enabling, disabling, uninstalling, reloading, and creating modules.
- **Power Mode**: The ability to point any model profile (chat, reason, or tools) at an OpenAI-compatible cloud or big-GPU endpoint. Delivers frontier-grade capability while keeping the local safety posture identical—including the curated registry, fail-closed confirms, grant intersection, localhost panel, network allowlist, and budget caps.
- **Provenance**: Modulus introduces the everyday evolution of Gurney (which succeeded ATLAS), fully rebuilt with an integrated UI, a module marketplace, and hive-mind memory.
