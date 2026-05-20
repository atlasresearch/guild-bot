// Per-dialect adapters within the openai-compat provider. Five small objects
// in a registry — keeps differences testable in isolation without 10 separate
// files (R3.1).
//
// Each dialect:
//   - declares its LlmCapabilities + parallelToolCallsDefault
//   - shapes the request: may add extra_body entries for vendor-specific knobs
//   - normalises the response: pulls reasoning_content out, etc.

import type { OpenAI } from 'openai'
import type { LlmCapabilities, LlmChatRequest, LlmChatResponse } from './messages'

export type DialectName = 'openai' | 'ollama-v1' | 'vllm' | 'llama-server' | 'generic'

export type Dialect = {
  name: DialectName
  capabilities: LlmCapabilities
  parallelToolCallsDefault: boolean
  /** Build extra_body entries (and any side effects on the OpenAI request) just before the SDK call. */
  shapeRequest: (req: LlmChatRequest) => { extraBody: Record<string, unknown> }
  /** Normalise the raw OpenAI response into the neutral LlmChatResponse shape. */
  normaliseResponse: (raw: OpenAI.Chat.Completions.ChatCompletion) => LlmChatResponse
}

// ──────────────────────────────────────────────────────────────────────────────
// Shared response normaliser. Most OpenAI-compatible servers return the same
// top-level shape; only the optional reasoning_content field differs by dialect.
// ──────────────────────────────────────────────────────────────────────────────

type RawMessage = OpenAI.Chat.Completions.ChatCompletionMessage & {
  reasoning_content?: string
  reasoning?: string
}

function baseNormalise(
  raw: OpenAI.Chat.Completions.ChatCompletion,
  dialect: DialectName,
  opts: { extractReasoning?: boolean } = {},
): LlmChatResponse {
  const choice = raw.choices[0]
  const msg = (choice?.message ?? {}) as RawMessage

  const toolCalls = (msg.tool_calls ?? [])
    .filter((tc): tc is OpenAI.Chat.Completions.ChatCompletionMessageToolCall =>
      tc.type === 'function' && tc.function != null,
    )
    .map((tc) => {
      const fn = tc.function
      const args = fn.arguments
      let parsed: Record<string, unknown>
      if (typeof args === 'string') {
        try {
          parsed = args ? (JSON.parse(args) as Record<string, unknown>) : {}
        } catch {
          parsed = {}
        }
      } else {
        parsed = (args as Record<string, unknown>) ?? {}
      }
      return { id: tc.id, name: fn.name, arguments: parsed }
    })

  const reasoning = opts.extractReasoning
    ? (msg.reasoning_content ?? msg.reasoning ?? undefined)
    : undefined

  const finishMap: Record<string, LlmChatResponse['finishReason']> = {
    stop: 'stop',
    length: 'length',
    tool_calls: 'tool_calls',
    function_call: 'tool_calls',
    content_filter: 'content_filter',
  }
  const finishReason = finishMap[choice?.finish_reason ?? 'stop'] ?? 'stop'

  return {
    content: msg.content ?? '',
    reasoning,
    toolCalls,
    model: raw.model,
    usage: raw.usage
      ? { inputTokens: raw.usage.prompt_tokens, outputTokens: raw.usage.completion_tokens }
      : undefined,
    finishReason,
    dialect,
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Dialect registry
// ──────────────────────────────────────────────────────────────────────────────

const openai: Dialect = {
  name: 'openai',
  parallelToolCallsDefault: true,
  capabilities: {
    toolCalling: true,
    thinking: false,
    structuredJson: true,
    structuredJsonSchema: true,
    embed: true,
  },
  shapeRequest: () => ({ extraBody: {} }),
  normaliseResponse: (raw) => baseNormalise(raw, 'openai'),
}

const ollamaV1: Dialect = {
  name: 'ollama-v1',
  parallelToolCallsDefault: true,
  capabilities: {
    toolCalling: true,
    thinking: false, // OpenAI-compat surface has no `think` param
    structuredJson: true,
    structuredJsonSchema: true, // Ollama 0.5+
    embed: true,
  },
  shapeRequest: () => ({ extraBody: {} }),
  normaliseResponse: (raw) => baseNormalise(raw, 'ollama-v1'),
}

const vllm: Dialect = {
  name: 'vllm',
  parallelToolCallsDefault: true,
  capabilities: {
    toolCalling: true,
    thinking: true,
    structuredJson: true,
    structuredJsonSchema: true,
    embed: true,
  },
  shapeRequest: (req) => {
    const extra: Record<string, unknown> = {}
    // R3.7: thinking: false → chat_template_kwargs.enable_thinking: false
    if (req.thinking === false) {
      extra.chat_template_kwargs = { enable_thinking: false }
    }
    return { extraBody: extra }
  },
  normaliseResponse: (raw) => baseNormalise(raw, 'vllm', { extractReasoning: true }),
}

const llamaServer: Dialect = {
  name: 'llama-server',
  parallelToolCallsDefault: false, // R3.6: off by default; opt-in via parallel_tool_calls
  capabilities: {
    toolCalling: true,
    thinking: true,
    structuredJson: true,
    structuredJsonSchema: true,
    embed: true,
  },
  shapeRequest: (req) => {
    const extra: Record<string, unknown> = {}
    if (req.thinking === false) {
      extra.chat_template_kwargs = { enable_thinking: false }
    }
    return { extraBody: extra }
  },
  normaliseResponse: (raw) => baseNormalise(raw, 'llama-server', { extractReasoning: true }),
}

const generic: Dialect = {
  name: 'generic',
  parallelToolCallsDefault: true,
  capabilities: {
    toolCalling: true,
    thinking: false,
    structuredJson: true,
    structuredJsonSchema: false, // conservative default
    embed: true,
  },
  shapeRequest: () => ({ extraBody: {} }),
  normaliseResponse: (raw) => baseNormalise(raw, 'generic'),
}

export const DIALECTS: Record<DialectName, Dialect> = {
  openai,
  'ollama-v1': ollamaV1,
  vllm,
  'llama-server': llamaServer,
  generic,
}

export const DIALECT_NAMES: DialectName[] = Object.keys(DIALECTS) as DialectName[]

// Track which fallback values we've already warned about so we don't spam
// the log on every chat() invocation.
const warnedFallbacks = new Set<string>()

export function getDialect(name: DialectName | undefined | null): Dialect {
  if (name && name in DIALECTS) return DIALECTS[name]
  const key = String(name ?? '<unset>')
  if (!warnedFallbacks.has(key)) {
    warnedFallbacks.add(key)
    console.warn(
      `[llm] config.llm.dialect is "${key}" (unset or unknown) — defaulting to "generic". ` +
        `Pick one of: ${DIALECT_NAMES.join(', ')}.`,
    )
  }
  return DIALECTS.generic
}
