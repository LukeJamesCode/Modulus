# Power Mode

Power Mode is Modulus's "make it as smart as the big guys" toggle. By default Modulus
runs a small local model on Ollama so it works on a Raspberry Pi. Power Mode points one
or more of its model **profiles** at a frontier model — a cloud endpoint (OpenAI,
DeepSeek, Groq, OpenRouter, …) or a big-GPU box you run yourself (vLLM, sglang,
llama.cpp) — while every safety guarantee stays exactly the same.

It is a **configuration**, not a different build: the same orchestrator, the same tool
tiers, the same confirm gate. Only the model behind a profile changes.

## How it works

`modulus-openai` registers every OpenAI-compatible endpoint you configure as an LLM
provider **alias** such as `deepseek:deepseek-chat` or `vllm:Qwen3-8B`. Modulus has three
model profiles:

| Profile  | Used for                                  |
| -------- | ----------------------------------------- |
| `chat`   | everyday conversation (the default)       |
| `reason` | hard problems (optional bigger model)     |
| `tools`  | tool-calling turns (falls back to `chat`) |

Set a profile's model tag to an alias and Modulus routes that profile to the endpoint
instead of local Ollama. The routing lives in the core LLM router (`src/core/llm-router.ts`):
any model tag that matches a registered provider id (`alias` or `alias:model`) is dispatched
to that provider; everything else stays on local Ollama. Streaming and tool calls work the
same on either side.

You can mix freely. A common Power Mode setup is **local `chat`, frontier `reason`** — fast
and free for small talk, frontier-grade only when a problem is actually hard. Or point all
three at a cloud endpoint for maximum capability.

## Turning it on

1. **Install `modulus-openai`** (Modules tab, or `modulus mod install modulus-openai`).
2. **Configure an endpoint and its API key.** The endpoint JSON and the `secret://…` key
   handle are documented in [the module's README](../modules/modulus-openai/README.md),
   which also lists base URLs for ~30 hosted and self-hosted providers. Minimal example:
   ```json
   [
     {
       "alias": "deepseek",
       "baseURL": "https://api.deepseek.com/v1",
       "apiKeySecret": "secret://openai-compatible/deepseek",
       "models": ["deepseek-chat", "deepseek-reasoner"],
       "supports": { "tools": true, "json_object": true, "reasoning_field": "reasoning_content" }
     }
   ]
   ```
3. **Point a profile at the alias.** Two ways:
   - **Panel → Settings → Models.** Once an endpoint is configured, its aliases appear in
     the Chat / Reasoning / Tools dropdowns alongside your local Ollama tags. Pick the alias
     for the slot you want to upgrade.
   - **CLI:** `modulus config` and set `models.chat` / `models.reason` / `models.tools` to
     the alias (e.g. `deepseek:deepseek-reasoner`).

That's it — the next turn on that profile runs on the frontier model.

## What does _not_ change

Power Mode never relaxes Modulus's safety posture:

- **Curated registry & consent.** `modulus-openai` is a first-party module installed through
  the same sha256-pinned, consent-gated pipeline as everything else.
- **Fail-closed confirms.** Confirm-tier tools still require human sign-off and fail closed in
  unattended runs, regardless of how smart the model is.
- **Grant intersection.** A module agent is still scoped to its own tools; a frontier model
  does not widen what a tool can do.
- **Localhost panel.** The web panel still binds to `127.0.0.1` behind a bearer token.
- **Network allowlist.** The module snapshots your configured `baseURL`s into
  `allowed_base_urls`; a call to any other host is refused loudly. Adding a new provider
  requires intentionally widening the allowlist.
- **Budget caps.** Optional per-endpoint daily call/token caps refuse loudly and record a
  `denied` row — Power Mode never silently spends or silently falls back to another endpoint.
- **Secrets.** API keys live as `secret://…` handles in module settings under `~/.modulus/`,
  never in the endpoint JSON and never printed by `/oaiendpoints`.

## Tested

The end-to-end Power Mode contract — a profile configured with an alias routing through the
real router to the real OpenAI-compatible provider, with streaming and tool calls, and _not_
hitting local Ollama — is covered by
[`modules/modulus-openai/lib/power-mode.test.ts`](../modules/modulus-openai/lib/power-mode.test.ts),
which drives the path by profile name against a stubbed endpoint (no key or network needed).
