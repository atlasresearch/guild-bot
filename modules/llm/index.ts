// Public API for @guildbot/llm.
//
// Reads config.llm.* on every call via @guildbot/guild-config — no caching (R1.4).
// SDK clients are reused across calls when their inputs match.

import { z } from 'zod'
import {
  type LlmChatRequest,
  type LlmChatResponse,
  type LlmMessage,
  UnsupportedCapabilityError,
} from './messages'
import { DIALECTS } from './dialects'
import * as ollamaNative from './providers/ollama-native'
import * as openaiCompat from './providers/openai-compat'
import { selectFor } from './select'

export type {
  LlmRole,
  LlmMessage,
  LlmTool,
  LlmJsonSchema,
  LlmResponseFormat,
  LlmChatRequest,
  LlmChatResponse,
  LlmCapabilities,
  LlmFinishReason,
  LlmToolCall,
} from './messages'
export { UnsupportedCapabilityError } from './messages'
export type { DialectName } from './dialects'

export async function chat(req: LlmChatRequest): Promise<LlmChatResponse> {
  const sel = selectFor('chat')
  const model = req.model ?? sel.model
  if (sel.provider === 'ollama') {
    return ollamaNative.chat({ ...req, model }, { baseUrl: sel.baseUrl, apiKey: sel.apiKey })
  }
  return openaiCompat.chat({ ...req, model }, {
    baseUrl: sel.baseUrl,
    apiKey: sel.apiKey,
    dialect: sel.dialect,
  })
}

export async function embed(text: string, opts?: { model?: string }): Promise<number[]> {
  const sel = selectFor('embed')
  const model = opts?.model ?? sel.model
  if (sel.provider === 'ollama') {
    return ollamaNative.embed(text, model, { baseUrl: sel.baseUrl, apiKey: sel.apiKey })
  }
  return openaiCompat.embed(text, model, {
    baseUrl: sel.baseUrl,
    apiKey: sel.apiKey,
    dialect: sel.dialect,
  })
}

// ──────────────────────────────────────────────────────────────────────────────
// structured()
// ──────────────────────────────────────────────────────────────────────────────

export type StructuredOptions<T> = {
  schema: z.ZodType<T>
  messages: LlmMessage[]
  model?: string
  thinking?: boolean
  extraBody?: Record<string, unknown>
  /** Name for the json_schema response_format (descriptive only). */
  schemaName?: string
}

export type StructuredResult<T> =
  | { success: true; data: T }
  | { success: false; error: string }

/**
 * Walk an error's `cause` chain and return a single human-readable string.
 *
 * Node's undici wraps low-level network failures as a generic `Error("fetch
 * failed")` with the real reason (ECONNREFUSED, ETIMEDOUT, UND_ERR_*, etc.)
 * hidden in `err.cause`. Surfacing only `err.message` loses every clue. This
 * walks up to three levels deep and includes the code if present.
 */
function formatErrorChain(e: unknown): string {
  const parts: string[] = []
  let cur: any = e
  let depth = 0
  while (cur && depth < 4) {
    const msg = cur?.message ?? String(cur)
    const code = cur?.code ? ` [${cur.code}]` : ''
    parts.push(`${msg}${code}`)
    cur = cur?.cause
    depth++
  }
  return parts.join(' ← caused by: ')
}

export async function structured<T>(opts: StructuredOptions<T>): Promise<StructuredResult<T>> {
  const sel = selectFor('structured')
  const model = opts.model ?? sel.model

  // Determine whether the active dialect supports json_schema.
  // - ollama-native always supports it (Ollama 0.5+).
  // - openai-compat: ask the active dialect.
  const supportsJsonSchema =
    sel.provider === 'ollama'
      ? ollamaNative.CAPABILITIES.structuredJsonSchema
      : DIALECTS[sel.dialect ?? 'generic']?.capabilities.structuredJsonSchema ?? false

  const req: LlmChatRequest = {
    model,
    messages: opts.messages,
    thinking: opts.thinking,
    extraBody: opts.extraBody,
    responseFormat: supportsJsonSchema
      ? {
          jsonSchema: {
            name: opts.schemaName ?? 'response',
            schema: z.toJSONSchema(opts.schema, { target: 'draft-7' }) as object,
            strict: true,
          },
        }
      : 'json',
  }

  let resp: LlmChatResponse
  try {
    resp = await chat(req)
  } catch (e) {
    return {
      success: false,
      error: `LLM request failed (provider=${sel.provider} model=${model} baseUrl=${sel.baseUrl ?? '<none>'}): ${formatErrorChain(e)}`,
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(resp.content || '{}')
  } catch (e) {
    return { success: false, error: `LLM did not return valid JSON: ${(e as Error).message}` }
  }

  const result = opts.schema.safeParse(parsed)
  if (!result.success) {
    return { success: false, error: result.error.message }
  }
  return { success: true, data: result.data }
}

// Test helper — re-exported so test files can drop SDK client caches.
export function _resetClientCachesForTests(): void {
  ollamaNative._resetClientCacheForTests()
  openaiCompat._resetClientCacheForTests()
}
