// Provider-neutral message and tool types used across all providers and dialects.
// Outer-wrapper Tool shape matches what tools/<name>/definition.json files
// already store, so the agent loop can forward them unchanged (R5.2).

export type LlmRole = 'system' | 'user' | 'assistant' | 'tool'

export type LlmToolCall = {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export type LlmMessage = {
  role: LlmRole
  content: string
  toolName?: string
  toolCallId?: string
  toolCalls?: LlmToolCall[]
}

export type LlmTool = {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: object
  }
}

export type LlmJsonSchema = {
  name: string
  schema: object
  strict?: boolean
}

export type LlmResponseFormat = 'text' | 'json' | { jsonSchema: LlmJsonSchema }

export type LlmChatRequest = {
  model?: string
  messages: LlmMessage[]
  tools?: LlmTool[]
  responseFormat?: LlmResponseFormat
  thinking?: boolean | { budgetTokens?: number }
  parallelToolCalls?: boolean
  temperature?: number
  maxTokens?: number
  extraBody?: Record<string, unknown>
}

export type LlmFinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter'

export type LlmChatResponse = {
  content: string
  reasoning?: string
  toolCalls: LlmToolCall[]
  model: string
  usage?: { inputTokens: number; outputTokens: number }
  finishReason: LlmFinishReason
  dialect?: string
}

export type LlmCapabilities = {
  toolCalling: boolean
  thinking: boolean
  structuredJson: boolean
  structuredJsonSchema: boolean
  embed: boolean
}

export class UnsupportedCapabilityError extends Error {
  constructor(
    public readonly capability: keyof LlmCapabilities,
    public readonly providerOrDialect: string,
  ) {
    super(
      `LLM capability "${capability}" is not supported by "${providerOrDialect}". ` +
        `Either change config.llm.* to a backend that supports it, or remove the request field.`,
    )
    this.name = 'UnsupportedCapabilityError'
  }
}

/**
 * Check that a request's opt-IN capability requirements are met by the active
 * provider/dialect. Opt-outs (thinking=false, parallelToolCalls=false,
 * responseFormat='text') are universally honourable and MUST NOT throw. R2.4.
 */
export function assertCapabilities(
  req: LlmChatRequest,
  caps: LlmCapabilities,
  providerOrDialect: string,
): void {
  if (req.thinking === true || (typeof req.thinking === 'object' && req.thinking !== null)) {
    if (!caps.thinking) throw new UnsupportedCapabilityError('thinking', providerOrDialect)
  }
  if (req.tools && req.tools.length > 0 && !caps.toolCalling) {
    throw new UnsupportedCapabilityError('toolCalling', providerOrDialect)
  }
  if (req.responseFormat === 'json' && !caps.structuredJson) {
    throw new UnsupportedCapabilityError('structuredJson', providerOrDialect)
  }
  if (
    typeof req.responseFormat === 'object' &&
    req.responseFormat &&
    'jsonSchema' in req.responseFormat &&
    !caps.structuredJsonSchema
  ) {
    throw new UnsupportedCapabilityError('structuredJsonSchema', providerOrDialect)
  }
}
