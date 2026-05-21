// OpenAI-SDK-based provider. Covers Ollama (/v1), OpenAI itself, vLLM,
// llama-server, and every other OpenAI-compatible host. Per-backend
// idiosyncrasies live in the dialect registry (../dialects.ts).

import { OpenAI } from 'openai'
import { verbose } from '@guildbot/interfaces'
import { toOpenAIMessages, toOpenAITools } from '../convert'
import { getDialect, type DialectName } from '../dialects'
import {
  assertCapabilities,
  type LlmCapabilities,
  type LlmChatRequest,
  type LlmChatResponse,
} from '../messages'

export type OpenAICompatOptions = {
  baseUrl?: string
  apiKey?: string
  dialect?: DialectName
}

// SDK client cache keyed by (baseUrl, apiKey). Per, the module re-reads
// config every call; SDK clients may be reused when inputs match.
let cachedClient: { key: string; instance: OpenAI } | null = null

function getClient(opts: OpenAICompatOptions): OpenAI {
  const key = `${opts.baseUrl ?? ''}|${opts.apiKey ?? ''}`
  if (cachedClient && cachedClient.key === key) return cachedClient.instance
  const instance = new OpenAI({
    baseURL: opts.baseUrl,
    // OpenAI SDK requires a string; local servers don't validate it, so use a placeholder
    apiKey: opts.apiKey ?? 'unused',
  })
  cachedClient = { key, instance }
  return instance
}

export function getCapabilities(dialectName: DialectName | undefined): LlmCapabilities {
  return getDialect(dialectName).capabilities
}

export async function chat(req: LlmChatRequest, opts: OpenAICompatOptions): Promise<LlmChatResponse> {
  const dialect = getDialect(opts.dialect)
  assertCapabilities(req, dialect.capabilities, `openai-compat:${dialect.name}`)

  if (!req.model) throw new Error('openai-compat chat(): model is required')

  const messages = toOpenAIMessages(req.messages)
  const tools = toOpenAITools(req.tools)

  const responseFormat = buildResponseFormat(req)
  const parallelToolCalls = req.parallelToolCalls ?? dialect.parallelToolCallsDefault

  const { extraBody: dialectExtras } = dialect.shapeRequest(req)
  const extraBody: Record<string, unknown> = { ...dialectExtras, ...(req.extraBody ?? {}) }

  verbose('llm:chat', {
    provider: 'openai-compat',
    dialect: dialect.name,
    model: req.model,
    messageCount: req.messages.length,
    toolCount: req.tools?.length ?? 0,
    thinking: req.thinking ?? null,
    hasResponseFormat: responseFormat != null,
  })

  const client = getClient(opts)
  const raw = await client.chat.completions.create({
    model: req.model,
    messages,
    tools,
    response_format: responseFormat,
    parallel_tool_calls: tools && tools.length ? parallelToolCalls : undefined,
    temperature: req.temperature,
    max_tokens: req.maxTokens,
    // OpenAI SDK accepts extra_body via a typed-passthrough; cast keeps tsc happy
    ...(Object.keys(extraBody).length ? ({ extra_body: extraBody } as Record<string, unknown>) : {}),
  } as Parameters<typeof client.chat.completions.create>[0])

  const normalised = dialect.normaliseResponse(raw as OpenAI.Chat.Completions.ChatCompletion)
  verbose('llm:chat:response', {
    provider: 'openai-compat',
    dialect: dialect.name,
    finishReason: normalised.finishReason,
    toolCalls: normalised.toolCalls.length,
    hasReasoning: !!normalised.reasoning,
  })
  return normalised
}

function buildResponseFormat(
  req: LlmChatRequest,
): OpenAI.Chat.Completions.ChatCompletionCreateParams['response_format'] {
  if (!req.responseFormat || req.responseFormat === 'text') return undefined
  if (req.responseFormat === 'json') return { type: 'json_object' }
  return {
    type: 'json_schema',
    json_schema: {
      name: req.responseFormat.jsonSchema.name,
      schema: req.responseFormat.jsonSchema.schema as Record<string, unknown>,
      strict: req.responseFormat.jsonSchema.strict ?? true,
    },
  }
}

export async function embed(
  text: string,
  model: string,
  opts: OpenAICompatOptions,
): Promise<number[]> {
  if (!text || !text.trim()) return []
  const client = getClient(opts)
  verbose('llm:embed', { provider: 'openai-compat', dialect: opts.dialect, model, textLength: text.length })
  const resp = await client.embeddings.create({ model, input: text })
  return resp.data[0]?.embedding ?? []
}

// Test helper — drops the cached client so unit tests can re-mock the SDK
export function _resetClientCacheForTests(): void {
  cachedClient = null
}
