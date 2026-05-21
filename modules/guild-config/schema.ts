import { z } from 'zod'

// A $secret reference in config.json. Inline strings are rejected for any field
// declared with `secretRef()` — secrets MUST live in secrets.json.
const secretRefSchema = z
  .object({
    $secret: z.string().min(1, '$secret reference must name a non-empty key'),
  })
  .strict()

/** A field that MUST be a $secret reference (never inline). */
const secretRef = () =>
  z.union([secretRefSchema, z.null(), z.undefined()]).optional()

/** A field that MUST be a $secret reference and is required. */
const requiredSecretRef = () => secretRefSchema

export type SecretRef = z.infer<typeof secretRefSchema>

export const isSecretRef = (v: unknown): v is SecretRef =>
  typeof v === 'object' && v !== null && '$secret' in v && typeof (v as SecretRef).$secret === 'string'

// Reject reserved prefixes ($env, $file) until they are supported.
const reservedRefSchema = z
  .object({
    $env: z.string().optional(),
    $file: z.string().optional(),
  })
  .partial()
  .passthrough()

export const detectReservedRef = (v: unknown): string | undefined => {
  if (typeof v !== 'object' || v === null) return undefined
  if ('$env' in v) return '$env'
  if ('$file' in v) return '$file'
  return undefined
}

export const llmProviderSchema = z.enum(['ollama', 'openai-compat', 'anthropic'])
export type LlmProvider = z.infer<typeof llmProviderSchema>

export const llmDialectSchema = z.enum([
  'openai',
  'ollama-v1',
  'vllm',
  'llama-server',
  'generic',
])
export type LlmDialect = z.infer<typeof llmDialectSchema>

export const guildBlockSchema = z
  .object({
    id: z.string().min(1, 'guild.id must be non-empty'),
    name: z.string().min(1, 'guild.name must be non-empty'),
    description: z.string().optional(),
  })
  .strict()

export const discordBlockSchema = z
  .object({
    token: requiredSecretRef(),
    applicationId: z.string().optional(),
    registerCommandsInGuildId: z.string().optional(),
    alwaysRecordingChannelId: z.string().nullable().optional(),
    recordingTranscriptChannelId: z.string().nullable().optional(),
  })
  .strict()

export const llmModelsSchema = z
  .object({
    default: z.string().min(1, 'llm.models.default is required'),
    chat: z.string().nullable().optional(),
    embed: z.string().min(1, 'llm.models.embed is required'),
    structured: z.string().nullable().optional(),
  })
  .strict()

export const llmEmbedOverridesSchema = z
  .object({
    provider: llmProviderSchema.nullable().optional(),
    baseUrl: z.string().nullable().optional(),
    dialect: llmDialectSchema.nullable().optional(),
  })
  .strict()

export const llmBlockSchema = z
  .object({
    provider: llmProviderSchema.default('ollama'),
    // dialect is required only when provider="openai-compat".
    // When omitted there, the module defaults to "generic" with a startup warning.
    dialect: llmDialectSchema.nullable().optional(),
    baseUrl: z.string().nullable().optional(),
    apiKey: secretRef(),
    models: llmModelsSchema,
    embed: llmEmbedOverridesSchema.optional().default({}),
  })
  .strict()

export const recordingBlockSchema = z
  .object({
    whisperModel: z.string().nullable().optional(),
  })
  .strict()

export const threadsCompactionSchema = z
  .object({
    thresholdMessages: z.number().int().positive().default(60),
    thresholdTokens: z.number().int().positive().default(20000),
    keepLastN: z.number().int().positive().default(10),
  })
  .strict()

export const threadsBlockSchema = z
  .object({
    compaction: threadsCompactionSchema.default({
      thresholdMessages: 60,
      thresholdTokens: 20000,
      keepLastN: 10,
    }),
  })
  .strict()

export const memoryBlockSchema = z
  .object({
    maxBytes: z.number().int().positive().default(32000),
    extractionEnabled: z.boolean().default(true),
    operatorRoleIds: z.array(z.string()).default([]),
  })
  .strict()

export const toolsBlockSchema = z
  .object({
    disabled: z.array(z.string()).default([]),
  })
  .strict()

// Pre-resolution schema: $secret references still in place.
export const rawGuildConfigSchema = z
  .object({
    $schema: z.string().optional(),
    version: z.literal(1),
    guild: guildBlockSchema,
    discord: discordBlockSchema,
    llm: llmBlockSchema,
    recording: recordingBlockSchema.default({}),
    threads: threadsBlockSchema.default({
      compaction: { thresholdMessages: 60, thresholdTokens: 20000, keepLastN: 10 },
    }),
    memory: memoryBlockSchema.default({
      maxBytes: 32000,
      extractionEnabled: true,
      operatorRoleIds: [],
    }),
    tools: toolsBlockSchema.default({ disabled: [] }),
  })
  .strict()

export type RawGuildConfig = z.infer<typeof rawGuildConfigSchema>

// Resolved config: secrets are strings.
export type GuildConfig = {
  $schema?: string
  version: 1
  guild: { id: string; name: string; description?: string }
  discord: {
    token: string
    applicationId?: string
    registerCommandsInGuildId?: string
    alwaysRecordingChannelId?: string | null
    recordingTranscriptChannelId?: string | null
  }
  llm: {
    provider: LlmProvider
    dialect: LlmDialect
    baseUrl?: string | null
    apiKey?: string | null
    models: { default: string; chat?: string | null; embed: string; structured?: string | null }
    embed: {
      provider?: LlmProvider | null
      baseUrl?: string | null
      dialect?: LlmDialect | null
    }
  }
  recording: { whisperModel?: string | null }
  threads: { compaction: { thresholdMessages: number; thresholdTokens: number; keepLastN: number } }
  memory: { maxBytes: number; extractionEnabled: boolean; operatorRoleIds: string[] }
  tools: { disabled: string[] }
}

export const secretsFileSchema = z.record(z.string().min(1), z.string())
export type SecretsFile = z.infer<typeof secretsFileSchema>
