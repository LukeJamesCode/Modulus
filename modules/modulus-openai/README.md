# modulus-openai

One Modulus extension for any provider that exposes an OpenAI-style
`POST <baseURL>/chat/completions` API.

This is Modulus's opt-in cloud or self-hosted escalation path. It does not change
the local Ollama default. Configure endpoints, install the extension, and each
endpoint becomes an LLM provider alias such as `deepseek:deepseek-reasoner` or
`groq:llama-3.3-70b-versatile`.

## What It Does

- Registers one `LLMProvider` per configured endpoint alias.
- Streams Server-Sent Events from OpenAI-compatible Chat Completions APIs.
- Supports native OpenAI tool calls where the endpoint does.
- Falls back to a JSON tool-call envelope when the endpoint has no native tool support.
- Tracks per-endpoint daily calls and tokens in SQLite.
- Adds Telegram commands:
  - `/oai <alias> <prompt>`
  - `/oaistatus`
  - `/oaiendpoints`

## Configuration

Modulus's current settings UI stores scalar values, so `endpoints` is a JSON
string setting. The extension validates it strictly at runtime.

Example:

```json
[
  {
    "alias": "deepseek",
    "baseURL": "https://api.deepseek.com/v1",
    "apiKeySecret": "secret://openai-compatible/deepseek",
    "models": ["deepseek-chat", "deepseek-reasoner"],
    "supports": {
      "tools": true,
      "json_object": true,
      "reasoning_field": "reasoning_content"
    },
    "region": "CN",
    "dailyCallLimit": 0,
    "dailyTokenLimit": 0
  }
]
```

`dailyCallLimit` and `dailyTokenLimit` are optional. Omit them or set `0` to
disable caps. When a cap is hit, the extension refuses loudly and records a
`denied` usage row. It never silently falls back to another endpoint.

## Secrets

Endpoint objects must use `secret://...` handles. Raw API keys do not belong in
the `endpoints` JSON.

This Modulus host does not yet expose `host.secrets`, so this extension mirrors
the existing Codex pattern: secret values are stored in the extension settings
table. The easiest path is the masked `secrets` setting, a JSON object whose
keys are `secret://...` handles and whose values are raw API keys.

For:

```json
"apiKeySecret": "secret://openai-compatible/deepseek"
```

set `secrets` to:

```json
{
  "secret://openai-compatible/deepseek": "sk-your-key"
}
```

For compatibility with older manual setups, the extension also checks a derived
setting key before the JSON map. The same handle above maps to:

```text
secret_openai-compatible_deepseek
```

Those settings live under `~/.modulus/` with the rest of Modulus's extension
state. They are not printed by `/oaiendpoints`.

## Network Allowlist

Modulus v1 manifests declare capabilities as strings; they do not yet support
dynamic per-domain network scopes. To keep this extension fail-loud, it snapshots
the configured endpoint `baseURL`s into `allowed_base_urls` the first time it
loads with endpoints configured.

If you later add a new provider and it is not in `allowed_base_urls`, calls are
refused with a message telling you to intentionally widen the allowlist. This
mirrors the "re-run ext update to widen capabilities" behavior as closely as the
current extension API allows.

## Supported Providers

OpenAI compatibility is a spectrum. This extension only needs a Chat Completions
endpoint, bearer auth, SSE streaming, and the standard `tools` shape for native
tool calls. Provider-specific extensions are still better for APIs that need
custom headers, nonstandard query strings, images, audio, embeddings, or native
non-OpenAI tool formats.

### Hosted Providers

| Provider | Base URL | Notes |
| --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | US-hosted/global, requires payment for API usage, tools supported on tool-capable models. |
| DeepSeek | `https://api.deepseek.com/v1` | CN-hosted, requires payment, tools/json mode supported on compatible models, `deepseek-reasoner` uses `reasoning_content`. |
| Groq | `https://api.groq.com/openai/v1` | Hosted inference, free tier available, payment for scale, tools vary by model. |
| Together AI | `https://api.together.xyz/v1` | Hosted open-model inference, requires payment/free credits vary, tools vary by model. |
| Fireworks AI | `https://api.fireworks.ai/inference/v1` | Hosted inference, requires payment/free credits vary, tools supported for compatible models. |
| OpenRouter | `https://openrouter.ai/api/v1` | Meta-provider, free models available, payment for many models, tools depend on routed model/provider. |
| Mistral La Plateforme | `https://api.mistral.ai/v1` | EU company/global API, requires payment/free tier varies, tools supported by newer models. |
| xAI Grok | `https://api.x.ai/v1` | Hosted, requires payment, regional endpoints such as `https://eu-west-1.api.x.ai/v1` are available, tools vary by model. |
| Cerebras Inference | `https://api.cerebras.ai/v1` | Hosted fast inference, free tier/payment availability may vary, mostly OpenAI-compatible, tools vary. |
| SambaNova Cloud | `https://api.sambanova.ai/v1` | Hosted SambaCloud, free account available, payment for production, OpenAI-compatible for supported models. |
| Perplexity Sonar | `https://api.perplexity.ai` | Hosted search-grounded models, requires payment, tools/search options are provider-specific; basic chat works. |
| DeepInfra | `https://api.deepinfra.com/v1/openai` | Hosted open-model inference, payment/free credits vary, tools depend on model. |
| Hyperbolic | `https://api.hyperbolic.xyz/v1` | Hosted open-model inference, requires payment/free credits vary, OpenAI-compatible chat streaming. |
| Novita AI | `https://api.novita.ai/openai` | Hosted inference, payment/free credits vary, OpenAI-compatible surface varies by model. |
| Nebius AI Studio | `https://api.studio.nebius.com/v1` | Hosted inference, requires payment/free credits vary, OpenAI-compatible chat. |

Examples:

```json
{ "alias": "openai", "baseURL": "https://api.openai.com/v1", "apiKeySecret": "secret://openai-compatible/openai", "models": ["gpt-4.1-mini"], "supports": { "tools": true, "json_object": true, "reasoning_field": "reasoning" } }
```

```json
{ "alias": "deepseek", "baseURL": "https://api.deepseek.com/v1", "apiKeySecret": "secret://openai-compatible/deepseek", "models": ["deepseek-chat", "deepseek-reasoner"], "supports": { "tools": true, "json_object": true, "reasoning_field": "reasoning_content" }, "region": "CN" }
```

```json
{ "alias": "groq", "baseURL": "https://api.groq.com/openai/v1", "apiKeySecret": "secret://openai-compatible/groq", "models": ["llama-3.3-70b-versatile"], "supports": { "tools": true, "json_object": true } }
```

```json
{ "alias": "together", "baseURL": "https://api.together.xyz/v1", "apiKeySecret": "secret://openai-compatible/together", "models": ["meta-llama/Llama-3.3-70B-Instruct-Turbo"], "supports": { "tools": false, "json_object": true } }
```

```json
{ "alias": "fireworks", "baseURL": "https://api.fireworks.ai/inference/v1", "apiKeySecret": "secret://openai-compatible/fireworks", "models": ["accounts/fireworks/models/llama-v3p1-70b-instruct"], "supports": { "tools": true, "json_object": true } }
```

```json
{ "alias": "openrouter", "baseURL": "https://openrouter.ai/api/v1", "apiKeySecret": "secret://openai-compatible/openrouter", "models": ["openai/gpt-4.1-mini", "deepseek/deepseek-r1"], "supports": { "tools": true, "json_object": true } }
```

```json
{ "alias": "mistral", "baseURL": "https://api.mistral.ai/v1", "apiKeySecret": "secret://openai-compatible/mistral", "models": ["mistral-large-latest"], "supports": { "tools": true, "json_object": true } }
```

```json
{ "alias": "xai", "baseURL": "https://api.x.ai/v1", "apiKeySecret": "secret://openai-compatible/xai", "models": ["grok-4.20-reasoning"], "supports": { "tools": true, "json_object": true, "reasoning_field": "reasoning" } }
```

```json
{ "alias": "cerebras", "baseURL": "https://api.cerebras.ai/v1", "apiKeySecret": "secret://openai-compatible/cerebras", "models": ["gpt-oss-120b"], "supports": { "tools": false, "json_object": true } }
```

```json
{ "alias": "sambanova", "baseURL": "https://api.sambanova.ai/v1", "apiKeySecret": "secret://openai-compatible/sambanova", "models": ["Meta-Llama-3.1-8B-Instruct"], "supports": { "tools": false, "json_object": true } }
```

```json
{ "alias": "perplexity", "baseURL": "https://api.perplexity.ai", "apiKeySecret": "secret://openai-compatible/perplexity", "models": ["sonar-pro"], "supports": { "tools": false, "json_object": false } }
```

```json
{ "alias": "deepinfra", "baseURL": "https://api.deepinfra.com/v1/openai", "apiKeySecret": "secret://openai-compatible/deepinfra", "models": ["meta-llama/Meta-Llama-3.1-70B-Instruct"], "supports": { "tools": false, "json_object": true } }
```

```json
{ "alias": "hyperbolic", "baseURL": "https://api.hyperbolic.xyz/v1", "apiKeySecret": "secret://openai-compatible/hyperbolic", "models": ["meta-llama/Meta-Llama-3.1-405B-Instruct"], "supports": { "tools": false, "json_object": true } }
```

```json
{ "alias": "novita", "baseURL": "https://api.novita.ai/openai", "apiKeySecret": "secret://openai-compatible/novita", "models": ["qwen/qwen3-max"], "supports": { "tools": false, "json_object": true } }
```

```json
{ "alias": "nebius", "baseURL": "https://api.studio.nebius.com/v1", "apiKeySecret": "secret://openai-compatible/nebius", "models": ["meta-llama/Meta-Llama-3.1-70B-Instruct"], "supports": { "tools": false, "json_object": true } }
```

### Self-Hosted Providers

Use a dummy key if your local server ignores bearer auth. The extension always
sends `Authorization: Bearer <secret>`.

| Provider | Default Base URL | Notes |
| --- | --- | --- |
| vLLM | `http://localhost:8000/v1` | Strong OpenAI Chat Completions support; tools depend on model/template/server flags. |
| sglang | `http://localhost:30000/v1` | OpenAI-compatible server; tools and structured output depend on launch options/model. |
| TGI | `http://localhost:8080/v1` | Messages API is OpenAI-compatible; tools vary. |
| llama.cpp `llama-server` | `http://localhost:8080/v1` | OpenAI-compatible chat server; tool support depends on build/model/template. |
| Ollama `/v1/chat/completions` | `http://localhost:11434/v1` | Experimental OpenAI compatibility; Modulus core already uses Ollama natively, so use this only for aliasing/proxy experiments. |
| LM Studio | `http://localhost:1234/v1` | Local server; tools depend on LM Studio version and model. |
| LocalAI | `http://localhost:8080/v1` | Self-hosted OpenAI replacement; tools depend on backend/model. |
| KoboldCpp | `http://localhost:5001/v1` | Partial OpenAI-compatible surface; chat works when the OpenAI endpoint is enabled. |
| Jan | `http://localhost:1337/v1` | Local app server; enable API server first. |
| GPT4All | `http://localhost:4891/v1` | Local app server; enable API server first; compatibility varies. |

Examples:

```json
{ "alias": "vllm", "baseURL": "http://localhost:8000/v1", "apiKeySecret": "secret://openai-compatible/vllm", "models": ["Qwen/Qwen3-8B"], "supports": { "tools": true, "json_object": true } }
```

```json
{ "alias": "sglang", "baseURL": "http://localhost:30000/v1", "apiKeySecret": "secret://openai-compatible/sglang", "models": ["Qwen/Qwen3-8B"], "supports": { "tools": true, "json_object": true } }
```

```json
{ "alias": "tgi", "baseURL": "http://localhost:8080/v1", "apiKeySecret": "secret://openai-compatible/tgi", "models": ["tgi"], "supports": { "tools": false, "json_object": true } }
```

```json
{ "alias": "llamacpp", "baseURL": "http://localhost:8080/v1", "apiKeySecret": "secret://openai-compatible/llamacpp", "models": ["local-model"], "supports": { "tools": false, "json_object": true } }
```

```json
{ "alias": "ollama-v1", "baseURL": "http://localhost:11434/v1", "apiKeySecret": "secret://openai-compatible/ollama", "models": ["qwen3.5:0.8b"], "supports": { "tools": true, "json_object": true } }
```

```json
{ "alias": "lmstudio", "baseURL": "http://localhost:1234/v1", "apiKeySecret": "secret://openai-compatible/lmstudio", "models": ["local-model"], "supports": { "tools": false, "json_object": true } }
```

```json
{ "alias": "localai", "baseURL": "http://localhost:8080/v1", "apiKeySecret": "secret://openai-compatible/localai", "models": ["local-model"], "supports": { "tools": false, "json_object": true } }
```

```json
{ "alias": "koboldcpp", "baseURL": "http://localhost:5001/v1", "apiKeySecret": "secret://openai-compatible/koboldcpp", "models": ["local-model"], "supports": { "tools": false, "json_object": false } }
```

```json
{ "alias": "jan", "baseURL": "http://localhost:1337/v1", "apiKeySecret": "secret://openai-compatible/jan", "models": ["local-model"], "supports": { "tools": false, "json_object": true } }
```

```json
{ "alias": "gpt4all", "baseURL": "http://localhost:4891/v1", "apiKeySecret": "secret://openai-compatible/gpt4all", "models": ["local-model"], "supports": { "tools": false, "json_object": false } }
```

### Partial Or Caveat Providers

| Provider | Base URL | Status |
| --- | --- | --- |
| Google Gemini OpenAI-compatible endpoint | `https://generativelanguage.googleapis.com/v1beta/openai` | Works for basic Chat Completions. Tool and safety/citation streaming behavior may differ from OpenAI. |
| Azure OpenAI | Resource-specific path | Not supported by this generic extension yet. Azure requires deployment-specific paths, `api-version` query parameters, and Azure auth conventions. Use a proxy such as LiteLLM or a future Azure sub-mode. |
| Cohere compatibility API | `https://api.cohere.ai/compatibility/v1` | Basic compatibility via Cohere's adapter. Tools and model behavior differ from OpenAI. |

Examples:

```json
{ "alias": "gemini", "baseURL": "https://generativelanguage.googleapis.com/v1beta/openai", "apiKeySecret": "secret://openai-compatible/gemini", "models": ["gemini-2.5-flash"], "supports": { "tools": true, "json_object": true } }
```

```json
{ "alias": "cohere", "baseURL": "https://api.cohere.ai/compatibility/v1", "apiKeySecret": "secret://openai-compatible/cohere", "models": ["command-a-03-2025"], "supports": { "tools": false, "json_object": true } }
```

For Azure OpenAI, run a proxy that exposes plain OpenAI Chat Completions and then
configure the proxy URL:

```json
{ "alias": "azure-via-litellm", "baseURL": "http://localhost:4000/v1", "apiKeySecret": "secret://openai-compatible/litellm", "models": ["azure/my-deployment"], "supports": { "tools": true, "json_object": true } }
```

### Explicitly Not Supported Here

Use dedicated extensions or a proxy for these:

- Anthropic Claude: native API is Messages, not OpenAI Chat Completions.
- MiniMax: use a dedicated extension or a compatibility proxy.
- AWS Bedrock: native auth and model routing are AWS-specific.

### Meta-Option: LiteLLM Proxy

LiteLLM is the escape hatch when an upstream provider needs custom headers,
Azure-style paths, provider-specific auth, or nonstandard compatibility.

```json
{ "alias": "litellm", "baseURL": "http://localhost:4000/v1", "apiKeySecret": "secret://openai-compatible/litellm", "models": ["openai/gpt-4.1-mini", "anthropic/claude-sonnet-4.5"], "supports": { "tools": true, "json_object": true } }
```

## Commands

```text
/oai deepseek "hello"
/oaiendpoints
/oaistatus
```

`/oai` sends a single user message to the first model listed for that endpoint.
Other extensions can call any configured model alias through `host.llm` using
`{ profile: { model: "alias:model" } }`.

## Known Limits

- Chat Completions only. No embeddings, images, audio, fine-tuning, Assistants, or Responses API.
- Only bearer authorization is sent.
- No provider-specific retry policy.
- No proxy settings or custom CA bundle.
- Tool support is only as good as the provider/model/template. When unsure, set
  `"tools": false` and let Modulus use the JSON-envelope fallback.
