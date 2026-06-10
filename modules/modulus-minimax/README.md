# modulus-minimax

Adds MiniMax (`chatcompletion_v2`) as a fully integrated LLM provider for Modulus. Once installed, MiniMax models (like `abab6.5s-chat`) become available system-wide for the core orchestrator, `modulus-tudor`, and any other extensions that request an LLM.

**Why a separate extension?**
This extension exists separately from `modulus-openai-compatible` because MiniMax's v2 API is not fully OpenAI-compatible. It has its own unique SSE streaming event format, tool-call chunking behavior, and error envelopes. If you need generic OpenAI-compatible provider support, see the [modulus-openai-compatible](../modulus-openai-compatible/README.md) extension instead.

> [!WARNING]
> **Data Residency Note**: MiniMax is a service hosted in mainland China (CN-hosted). By using this extension and sending requests to the `api.minimaxi.chat` endpoint, your prompts, context, and conversation data will be processed and stored in China. Users with strict data-residency requirements should take note.

## Installation

```sh
modulus ext install modulus-minimax
```

## Setup

Run the built-in auth flow to securely store your MiniMax API Key:

```sh
modulus auth modulus-minimax
```

*Get your API Key from the [MiniMax API Platform](https://platform.minimaxi.com/).*

## Configuration

You can configure budget limits and default models via the interactive config menu:

```sh
modulus config modulus-minimax
```

**Settings available:**
- `model`: The default MiniMax model to use (default: `abab6.5s-chat`).
- `ceiling`: A daily total token cap (input + output) to prevent budget overruns. Reaching this limit will cleanly fail LLM requests until local midnight. Set to `0` to disable the cap.
- `timeout_ms`: Network timeout for MiniMax requests (default `180000`).

## Telegram Commands

- `/minimax <prompt>` — Send a one-shot query to the configured MiniMax model.
- `/minimaxstatus` — Check your daily token usage and remaining budget.
- `/minimaxlogout` — Clear your stored MiniMax API key from Modulus.

## Supported Models

This extension registers any MiniMax chat model. By default, it uses `abab6.5s-chat`. You can set the model in `modulus config modulus-minimax` or explicitly request it in other extensions using `host.llm.chat({ profile: { model: 'minimax:abab6.5s-chat' }, ... })`.
