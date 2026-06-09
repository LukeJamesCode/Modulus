# Security

## Reporting a vulnerability

**Do not file a public GitHub issue for security vulnerabilities.** Contact the maintainer directly. Once a fix is ready, the issue will be disclosed publicly with the release notes.

---

## Threat model

Modulus is a self-hosted tool designed to run on your own hardware. The attack surface is small by design — there is no web UI, no public HTTP server, and no inbound ports in a default install.

### What runs locally

| Component                  | Outbound connections                                                                           |
| -------------------------- | ---------------------------------------------------------------------------------------------- |
| Modulus core               | Telegram API (long-poll), Ollama (local HTTP)                                                  |
| modulus-everyday-assistant | Google Calendar API, Google Tasks API, Google OAuth, Open-Meteo (no account)                   |
| modulus-websearch          | DuckDuckGo or your self-hosted SearXNG                                                         |
| modulus-memgraph           | Your self-hosted FalkorDB bridge                                                               |
| modulus-voice              | huggingface.co (one-shot whisper model download); rest is local (Piper + whisper.cpp binaries) |
| modulus-instant-responses  | No network                                                                                     |

No telemetry. No analytics. No outbound calls except to the services you configure.

### Inbound exposure

- No open ports in a default install
- `modulus auth` opens a **temporary** local HTTP server on a random port to capture OAuth callbacks; it shuts down immediately after the token is captured
- `modulus-memgraph`'s bridge is a separate process you run yourself; Modulus only makes outbound HTTP calls to it

---

## Secret handling

### Storage

All credentials (Telegram bot token, Google OAuth client ID/secret/refresh tokens, API keys) are stored in:

- `~/.modulus/config.json` (mode `0600`) — Telegram token
- `~/.modulus/modulus.db` (SQLite, mode `0600`) — extension credentials via `extension_settings`
- `~/.modulus/log/modulus.log`, `~/.modulus/modulus.pid`, and `~/.modulus/metrics.json` (mode `0600`) — operational state

Modulus also tightens `~/.modulus/`, `~/.modulus/log/`, and extension state directories to mode `0700` at startup/config writes. On filesystems that do not support POSIX permissions this is best-effort, so keep the host directory private at the OS/container layer too.

Access is OS-level. If an attacker has read access to these files, they have your credentials. Protect the `~/.modulus/` directory accordingly.

### Log redaction

The structured logger (`src/util/redact.ts`) runs on every log call and scrubs values that pattern-match common secret formats (bot tokens, Bearer tokens, OAuth codes) before they reach stdout or `~/.modulus/log/modulus.log`.

If you share logs for debugging, check for unredacted values before posting publicly — the redactor catches common patterns but is not exhaustive.

### `modulus config` masking

Settings marked `"secret": true` in an extension's `settings.schema.json` are masked in the interactive TUI prompt and in `modulus status` output. The underlying stored value is plaintext in SQLite.

---

## Allowlist enforcement

The `telegram.allowedIds` list is the primary access control. Messages from any Telegram user ID not on this list are silently dropped before they reach the orchestrator. The check happens in the Telegram adapter, before any LLM call or tool execution.

Keep this list to the minimum set of users who should have access. The bot can execute tools that mutate state (add calendar events, complete tasks, store reminders) — treat it like a shell account on the machine it runs on.

---

## Tool permission tiers

Extensions register tools at one of three tiers:

| Tier      | Behaviour                                                           |
| --------- | ------------------------------------------------------------------- |
| `auto`    | Runs without user confirmation. Use for read-only tools.            |
| `confirm` | Sends a Telegram confirmation prompt before running.                |
| `owner`   | Runs only for users with the owner role (first ID in `allowedIds`). |

When installing a third-party extension, review its `tools.ts` to confirm that mutating tools use `confirm` or `owner` tier rather than `auto`.

---

## Extension security

Extensions run in-process with full Node.js privileges. A malicious extension has access to:

- The shared SQLite database
- All `host.*` APIs (settings, tools, Telegram, scheduler)
- The filesystem
- The network

Only install extensions you trust. The bundled first-party extensions in `extensions/` are reviewed as part of the main codebase.

Third-party extensions installed via git URL run whatever code is in that repository. Review the code before installing. In particular, check `tools.ts`, `jobs.ts`, and `auth.ts`.

---

## Docker security

When running under Docker Compose:

- The Modulus container runs as a non-root user
- The Modulus container drops all Linux capabilities, uses `no-new-privileges`, runs with a read-only root filesystem, and has a small hardened `/tmp` tmpfs
- The `modulus-data` volume holds your config and SQLite DB — restrict access to this volume
- The Ollama container does not publish ports to the host in the provided Compose file; it's reachable only on the internal Docker network

If you expose the Docker host to a network, ensure the Ollama port (11434) is not publicly reachable — it has no authentication. If you intentionally publish it, place it behind firewall rules or an authenticated reverse proxy.

### Remote update command

`/update` performs a `git pull --ff-only` on the running checkout. Because this changes code that will run on the host, it is restricted to the owner: the first Telegram user ID in `telegram.allowedIds` / `TELEGRAM_ALLOWED_IDS`. Other allowlisted users can chat with the agent but cannot invoke remote code updates.
