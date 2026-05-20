# @guildbot/llm

Provider-neutral LLM module. All chat, embedding, and structured-output calls in the bot go through here.

## Public API

```ts
import { chat, embed, structured } from '@guildbot/llm'
```

- `chat(req)` — agentic chat completion with tool calling, returns a normalised `LlmChatResponse`.
- `embed(text, opts?)` — produces an embedding vector.
- `structured({ schema, messages, ... })` — validated JSON output against a Zod schema. Prefers `response_format: { json_schema }` when the active dialect supports it, falls back to `json_object` + manual parse otherwise.

`config.llm.*` is re-read on every call (no caching) via `@guildbot/guild-config`.

## Providers

| Provider | When to use | What it gets you |
|---|---|---|
| `ollama` | Default. Local Ollama via the `ollama` npm package. | `think: true`, `<think>` reasoning, native tool calling, JSON schema |
| `openai-compat` | Anything that speaks OpenAI's `/v1/chat/completions`: OpenAI itself, vLLM, llama-server, Ollama via `/v1`, OpenRouter, etc. | Tool calling + JSON modes via the OpenAI SDK, per-dialect quirks |

Pick via `config.llm.provider`. When using `openai-compat`, also pick a dialect via `config.llm.dialect`.

## Dialects (within `openai-compat`)

| Dialect | Tool calls | Reasoning content | Parallel tool calls default | Notes |
|---|---|---|---|---|
| `openai` | ✅ | n/a | on | Stock OpenAI / OpenRouter / Together / Fireworks |
| `ollama-v1` | ✅ | ❌ (no native `think` on `/v1`) | on | Ollama's OpenAI-compatible surface |
| `vllm` | ✅ requires `--enable-auto-tool-choice` + `--tool-call-parser <parser>` | ✅ via `--reasoning-parser`, surfaced as `message.reasoning_content` | on | Forwards `chat_template_kwargs`, `guided_json`, `guided_regex`, `guided_choice`, `structured_outputs` via `extra_body` |
| `llama-server` | ✅ requires `--jinja` (sometimes `--chat-template-file`) | ✅ via `--reasoning-format deepseek`, surfaced as `message.reasoning_content` | **off** — opt in per-request with `parallelToolCalls: true` | Forwards `grammar`, `json_schema`, `chat_template_kwargs` via `extra_body` |
| `generic` | passthrough | n/a | on | Fallback when the operator hasn't picked a dialect; conservative capability defaults |

There is no `auto` dialect — port-based detection is unreliable behind proxies and containers. Pick explicitly. When omitted under `openai-compat`, the module uses `generic` and logs a one-line warning.

## Server prerequisites

### vLLM

```bash
vllm serve Qwen/Qwen3-32B \
  --enable-auto-tool-choice \
  --tool-call-parser hermes \
  --reasoning-parser qwen3
```

Parser selection depends on the model. The vLLM docs maintain the canonical list; for Qwen2.5/3 use `hermes`, for Llama 3.x use `llama3_json`, for Llama 4 use `llama4_pythonic`.

### llama-server

```bash
llama-server -m model.gguf --jinja \
  --chat-template-file templates/llama-cpp-deepseek-r1.jinja \   # if needed
  --reasoning-format deepseek                                    # optional: surfaces reasoning_content
```

Parallel tool calls are off by default; opt-in per-request with `parallelToolCalls: true`.

### Ollama (`/v1` or native)

No server-side configuration beyond `ollama serve`. Native (`provider: "ollama"`) additionally supports `thinking: true` and inline `<think>` extraction.

### OpenAI

No server-side prerequisites; behaviour is set by the hosted product.

## Configuration sketches

Default (Ollama native):

```jsonc
{
  "llm": {
    "provider": "ollama",
    "baseUrl": "http://localhost:11434",
    "models": { "default": "qwen3.6", "embed": "nomic-embed-text" }
  }
}
```

vLLM:

```jsonc
{
  "llm": {
    "provider": "openai-compat",
    "dialect": "vllm",
    "baseUrl": "http://localhost:8000/v1",
    "models": { "default": "Qwen/Qwen3-32B", "embed": "intfloat/e5-large-v2" }
  }
}
```

llama-server:

```jsonc
{
  "llm": {
    "provider": "openai-compat",
    "dialect": "llama-server",
    "baseUrl": "http://localhost:8080/v1",
    "models": { "default": "qwen3", "embed": "nomic-embed-text" }
  }
}
```

OpenAI:

```jsonc
{
  "llm": {
    "provider": "openai-compat",
    "dialect": "openai",
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": { "$secret": "llm.apiKey" },
    "models": { "default": "gpt-4o-mini", "embed": "text-embedding-3-small" }
  }
}
```

Secret values always live in the guild's `secrets.json`, never inline. See [plan 003](../../.specs/archive/003-per-guild-config-plan.md).

## Capability checks

The module throws `UnsupportedCapabilityError` only when a request **actively asks for** a capability the active dialect can't honour:

- `thinking: true` against `ollama-v1` or `openai` or `generic` throws.
- `thinking: false` against any dialect succeeds (opt-out is universal).
- `parallelToolCalls: false` against any dialect succeeds.
- `responseFormat: 'text'` against any dialect succeeds.
