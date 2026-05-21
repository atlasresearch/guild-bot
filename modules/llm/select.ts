// Read config.llm.* via @guildbot/guild-config, return the active provider's
// dispatch info. Called at the top of every chat()/embed()/structured() call
// — no caching.

import { loadConfig, type LlmDialect, type LlmProvider } from '@guildbot/guild-config'
import type { DialectName } from './dialects'

export type Role = 'chat' | 'embed' | 'structured'

export type Selection = {
  provider: LlmProvider
  dialect?: DialectName
  baseUrl?: string
  apiKey?: string
  model: string
}

export function selectFor(role: Role): Selection {
  const cfg = loadConfig()
  const llm = cfg.llm

  // For embeddings, optionally route to a different backend
  const useEmbedOverrides = role === 'embed' && llm.embed && (
    llm.embed.provider != null || llm.embed.baseUrl != null || llm.embed.dialect != null
  )

  const provider = useEmbedOverrides
    ? ((llm.embed?.provider as LlmProvider | null) ?? llm.provider)
    : llm.provider

  const baseUrl = useEmbedOverrides
    ? (llm.embed?.baseUrl ?? llm.baseUrl ?? undefined)
    : (llm.baseUrl ?? undefined)

  const dialect = (useEmbedOverrides
    ? ((llm.embed?.dialect as LlmDialect | null) ?? llm.dialect)
    : llm.dialect) as DialectName | undefined

  const apiKey = (llm.apiKey ?? undefined) as string | undefined

  // Model fallback chain
  let model: string
  if (role === 'chat') {
    model = llm.models.chat ?? llm.models.default
  } else if (role === 'embed') {
    model = llm.models.embed ?? llm.models.default
  } else {
    model = llm.models.structured ?? llm.models.default
  }

  return {
    provider,
    dialect: provider === 'openai-compat' ? (dialect ?? undefined) : undefined,
    baseUrl,
    apiKey,
    model,
  }
}
