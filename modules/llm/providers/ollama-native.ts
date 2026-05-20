// Native Ollama provider via the `ollama` npm package. Supports `think`,
// `preserve_thinking`, and `format: 'json' | <json schema>` — features that the
// /v1 OpenAI-compatible surface does not expose.

import { Ollama } from 'ollama'
import { verbose } from '@guildbot/interfaces'
import { toOllamaMessages } from '../convert'
import {
  assertCapabilities,
  type LlmCapabilities,
  type LlmChatRequest,
  type LlmChatResponse,
} from '../messages'

export type OllamaNativeOptions = {
  baseUrl?: string
  apiKey?: string // generally unused
}

let cachedClient: { key: string; instance: Ollama } | null = null

function getClient(opts: OllamaNativeOptions): Ollama {
  const key = `${opts.baseUrl ?? ''}|${opts.apiKey ?? ''}`
  if (cachedClient && cachedClient.key === key) return cachedClient.instance
  const instance = new Ollama({ host: opts.baseUrl })
  cachedClient = { key, instance }
  return instance
}

export const CAPABILITIES: LlmCapabilities = {
  toolCalling: true,
  thinking: true,
  structuredJson: true,
  structuredJsonSchema: true,
  embed: true,
}

const THINK_BLOCK_RE = /<think>([\s\S]*?)<\/think>\s*/g

export async function chat(req: LlmChatRequest, opts: OllamaNativeOptions): Promise<LlmChatResponse> {
  assertCapabilities(req, CAPABILITIES, 'ollama-native')
  if (!req.model) throw new Error('ollama-native chat(): model is required')

  const messages = toOllamaMessages(req.messages)

  // Map our responseFormat to Ollama's `format` field:
  //   'json' -> 'json'
  //   { jsonSchema: { schema } } -> the JSON schema object (Ollama 0.5+)
  let format: unknown
  if (req.responseFormat === 'json') format = 'json'
  else if (typeof req.responseFormat === 'object' && req.responseFormat && 'jsonSchema' in req.responseFormat) {
    format = req.responseFormat.jsonSchema.schema
  }

  const think = req.thinking === true || (typeof req.thinking === 'object' && req.thinking != null)

  verbose('llm:chat', {
    provider: 'ollama-native',
    model: req.model,
    messageCount: req.messages.length,
    toolCount: req.tools?.length ?? 0,
    thinking: think,
    hasFormat: format != null,
  })

  const client = getClient(opts)
  const raw = await client.chat({
    model: req.model,
    messages,
    tools: req.tools as unknown as Parameters<typeof client.chat>[0]['tools'],
    think,
    format: format as 'json' | object | undefined,
    options: {
      temperature: req.temperature,
      num_predict: req.maxTokens,
    },
  } as Parameters<typeof client.chat>[0])

  // Pull <think>...</think> blocks out of content into reasoning, if present.
  // Some Qwen variants and most reasoning models emit them inline.
  const rawContent = raw.message?.content ?? ''
  const reasoningParts: string[] = []
  const cleanedContent = rawContent.replace(THINK_BLOCK_RE, (_, inner: string) => {
    reasoningParts.push(inner.trim())
    return ''
  }).trim()

  // The Ollama SDK exposes a `thinking` field separately on newer versions.
  // Prefer that over scraped <think> tags if present.
  const sdkThinking = (raw.message as { thinking?: string } | undefined)?.thinking
  const reasoning = sdkThinking || (reasoningParts.length ? reasoningParts.join('\n\n') : undefined)

  const toolCalls = (raw.message?.tool_calls ?? []).map((tc, i) => {
    const fn = tc.function
    return {
      id: `call_${i}`,
      name: fn.name,
      arguments: (fn.arguments as Record<string, unknown>) ?? {},
    }
  })

  const finishReason: LlmChatResponse['finishReason'] = toolCalls.length ? 'tool_calls' : 'stop'

  const response: LlmChatResponse = {
    content: cleanedContent,
    reasoning,
    toolCalls,
    model: raw.model ?? req.model,
    usage: raw.prompt_eval_count
      ? { inputTokens: raw.prompt_eval_count, outputTokens: raw.eval_count ?? 0 }
      : undefined,
    finishReason,
    dialect: 'ollama-native',
  }
  verbose('llm:chat:response', {
    provider: 'ollama-native',
    finishReason: response.finishReason,
    toolCalls: response.toolCalls.length,
    hasReasoning: !!response.reasoning,
  })
  return response
}

export async function embed(
  text: string,
  model: string,
  opts: OllamaNativeOptions,
): Promise<number[]> {
  if (!text || !text.trim()) return []
  const client = getClient(opts)
  verbose('llm:embed', { provider: 'ollama-native', model, textLength: text.length })
  const resp = await client.embeddings({ model, prompt: text })
  return resp.embedding
}

export function _resetClientCacheForTests(): void {
  cachedClient = null
}
