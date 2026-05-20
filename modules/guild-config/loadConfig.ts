import { readFileSync, statSync } from 'node:fs'
import { z } from 'zod'
import { paths } from './paths'
import { resolveGuildDir } from './resolveGuildDir'
import {
  detectReservedRef,
  isSecretRef,
  rawGuildConfigSchema,
  secretsFileSchema,
  type GuildConfig,
  type RawGuildConfig,
  type SecretsFile,
} from './schema'

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

const FORBIDDEN_PERMS_MASK = 0o077 // any group/world bit means refuse

function readConfigFile(configPath: string): unknown {
  let raw: string
  try {
    raw = readFileSync(configPath, 'utf8')
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new ConfigError(`config.json not found at ${configPath}`)
    }
    throw new ConfigError(`Failed to read ${configPath}: ${(e as Error).message}`)
  }
  try {
    return JSON.parse(raw)
  } catch (e) {
    throw new ConfigError(`Failed to parse ${configPath}: ${(e as Error).message}`)
  }
}

function readSecretsFile(secretsPath: string): SecretsFile {
  let stat
  try {
    stat = statSync(secretsPath)
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new ConfigError(
        `secrets.json not found at ${secretsPath}. Create it with mode 0600 and add the keys referenced by config.json.`,
      )
    }
    throw e
  }

  // R4.4: refuse if group/world readable or writable
  if ((stat.mode & FORBIDDEN_PERMS_MASK) !== 0) {
    const octal = (stat.mode & 0o777).toString(8)
    throw new ConfigError(
      `secrets.json has unsafe permissions (mode ${octal}). Run \`chmod 0600 ${secretsPath}\` and retry.`,
    )
  }

  let raw: string
  try {
    raw = readFileSync(secretsPath, 'utf8')
  } catch (e) {
    throw new ConfigError(`Failed to read ${secretsPath}: ${(e as Error).message}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new ConfigError(`Failed to parse ${secretsPath}: ${(e as Error).message}`)
  }

  // R4.3: flat object only
  const result = secretsFileSchema.safeParse(parsed)
  if (!result.success) {
    throw new ConfigError(
      `secrets.json is invalid (must be a flat object of string → string): ${result.error.message}`,
    )
  }
  // Reject nested objects explicitly (record schema permits strings only, but be explicit)
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== 'string') {
      throw new ConfigError(
        `secrets.json key "${k}" must be a string; nested objects are not supported.`,
      )
    }
  }
  return result.data
}

/**
 * Walk an arbitrary object and reject reserved $env: / $file: prefixes
 * before they reach the schema validator. R4.6.
 */
function rejectReservedPrefixes(node: unknown, pathStack: string[] = []): void {
  if (Array.isArray(node)) {
    node.forEach((item, i) => rejectReservedPrefixes(item, [...pathStack, String(i)]))
    return
  }
  if (typeof node !== 'object' || node === null) return
  const prefix = detectReservedRef(node)
  if (prefix) {
    throw new ConfigError(
      `${pathStack.join('.') || '<root>'}: ${prefix} references are not yet supported — write the value to secrets.json and use { "$secret": "<key>" } instead.`,
    )
  }
  for (const [k, v] of Object.entries(node)) {
    rejectReservedPrefixes(v, [...pathStack, k])
  }
}

/**
 * Walk the validated raw config and replace every {$secret: "key"} with the
 * matching value from secrets.json. Throws ConfigError if any referenced key
 * is missing. R4.5.
 */
function resolveSecrets<T>(node: T, secrets: SecretsFile, pathStack: string[] = []): T {
  if (Array.isArray(node)) {
    return node.map((item, i) => resolveSecrets(item, secrets, [...pathStack, String(i)])) as unknown as T
  }
  if (node === null || typeof node !== 'object') return node

  if (isSecretRef(node)) {
    const key = node.$secret
    if (!(key in secrets)) {
      throw new ConfigError(
        `${pathStack.join('.') || '<root>'}: missing secret "${key}" in secrets.json`,
      )
    }
    return secrets[key] as unknown as T
  }

  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    out[k] = resolveSecrets(v, secrets, [...pathStack, k])
  }
  return out as T
}

/**
 * Deep-freeze an object so callers cannot mutate the returned config. R2.5.
 */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const v of Object.values(value)) deepFreeze(v)
    Object.freeze(value)
  }
  return value
}

function formatZodError(error: z.ZodError, kind: string): string {
  const lines = error.issues.map((issue) => {
    const path = issue.path.length ? issue.path.join('.') : '<root>'
    return `  • ${path}: ${issue.message}`
  })
  return `${kind} validation failed:\n${lines.join('\n')}`
}

// Paths in the raw config that MUST hold a $secret reference (never an inline string).
const SECRET_FIELD_PATHS = ['discord.token', 'llm.apiKey'] as const

function getByPath(obj: unknown, dottedPath: string): unknown {
  return dottedPath.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key]
    }
    return undefined
  }, obj)
}

/**
 * Detect inline strings in secret-only fields before the schema runs so the
 * user gets a targeted "secrets must be in secrets.json" error. R4.2.
 */
function rejectInlineSecrets(rawObj: unknown): void {
  for (const path of SECRET_FIELD_PATHS) {
    const value = getByPath(rawObj, path)
    if (typeof value === 'string') {
      throw new ConfigError(
        `${path}: inline string secrets are not permitted. Move the value to secrets.json and use { "$secret": "${path}" } here.`,
      )
    }
  }
}

/**
 * Reads `config.json` and `secrets.json` from the active guild dir (or the
 * provided override), validates the schema, resolves $secret references,
 * and returns a frozen GuildConfig.
 *
 * MUST be called every time a value is needed — there is no module-level
 * cache. R2.4.
 */
export function loadConfig(guildDir?: string): GuildConfig {
  const root = guildDir ?? resolveGuildDir()
  const p = paths(root)

  const rawObj = readConfigFile(p.config)

  // R4.6: reject reserved prefixes before schema validation so the user gets
  // a targeted message rather than a generic schema failure.
  rejectReservedPrefixes(rawObj)

  // R4.2: reject inline strings in fields that MUST be $secret references
  // (checked before schema so the error message names the policy clearly).
  rejectInlineSecrets(rawObj)

  const parsed = rawGuildConfigSchema.safeParse(rawObj)
  if (!parsed.success) {
    throw new ConfigError(formatZodError(parsed.error, 'config.json'))
  }

  const secrets = readSecretsFile(p.secrets)
  const resolved = resolveSecrets<RawGuildConfig>(parsed.data, secrets) as unknown as GuildConfig
  return deepFreeze(resolved)
}
