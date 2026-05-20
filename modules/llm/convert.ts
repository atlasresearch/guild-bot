// Converters between the neutral LlmMessage / LlmTool shape and each
// provider SDK's native message shape. Kept thin and stateless.

import type { OpenAI } from 'openai'
import type { LlmMessage, LlmTool } from './messages'

// ──────────────────────────────────────────────────────────────────────────────
// OpenAI SDK shapes
// ──────────────────────────────────────────────────────────────────────────────

export function toOpenAIMessages(messages: LlmMessage[]): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return messages.map((m): OpenAI.Chat.Completions.ChatCompletionMessageParam => {
    if (m.role === 'tool') {
      return {
        role: 'tool',
        content: m.content,
        tool_call_id: m.toolCallId ?? '',
      }
    }
    if (m.role === 'assistant') {
      const out: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
        role: 'assistant',
        content: m.content,
      }
      if (m.toolCalls && m.toolCalls.length) {
        out.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments ?? {}) },
        }))
      }
      return out
    }
    if (m.role === 'system') {
      return { role: 'system', content: m.content }
    }
    return { role: 'user', content: m.content }
  })
}

// LlmTool is already the OpenAI/Ollama outer-wrapper shape, so the SDK accepts
// it as-is. This helper exists only for type-narrowing at call sites.
export function toOpenAITools(
  tools: LlmTool[] | undefined,
): OpenAI.Chat.Completions.ChatCompletionTool[] | undefined {
  if (!tools || !tools.length) return undefined
  return tools as unknown as OpenAI.Chat.Completions.ChatCompletionTool[]
}

// ──────────────────────────────────────────────────────────────────────────────
// Ollama-native SDK shapes
// ──────────────────────────────────────────────────────────────────────────────

type OllamaMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>
}

export function toOllamaMessages(messages: LlmMessage[]): OllamaMessage[] {
  return messages.map((m): OllamaMessage => {
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length) {
      return {
        role: 'assistant',
        content: m.content,
        tool_calls: m.toolCalls.map((tc) => ({
          function: { name: tc.name, arguments: tc.arguments ?? {} },
        })),
      }
    }
    return { role: m.role, content: m.content }
  })
}
