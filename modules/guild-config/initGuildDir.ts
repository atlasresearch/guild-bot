import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DATA_SUBDIRS, paths } from './paths'
import { rawGuildConfigSchema, type RawGuildConfig } from './schema'

export type InitGuildDirOptions = {
  /** Partial config to merge onto the default template. */
  config?: Record<string, unknown>
  /** Secrets to write into secrets.json (mode 0600). */
  secrets?: Record<string, string>
  /**
   * Path to the codebase root containing tools/, skills/, guild-defaults/,
   * config.example.json. Defaults to the source-tree root inferred from this file.
   */
  codebaseRoot?: string
}

const HERE = dirname(fileURLToPath(import.meta.url))
// modules/guild-config/initGuildDir.ts → repo root is two levels up
const DEFAULT_CODEBASE_ROOT = resolve(HERE, '..', '..')

function defaultConfig(): RawGuildConfig {
  return {
    version: 1,
    guild: { id: 'discord:placeholder', name: 'placeholder' },
    discord: { token: { $secret: 'discord.token' } },
    llm: {
      provider: 'ollama',
      baseUrl: 'http://localhost:11434',
      apiKey: undefined,
      models: { default: 'qwen3.6', embed: 'nomic-embed-text' },
      embed: {},
    },
    recording: { whisperModel: null },
    threads: {
      compaction: { thresholdMessages: 60, thresholdTokens: 20000, keepLastN: 10 },
    },
    memory: { maxBytes: 32000, extractionEnabled: true, operatorRoleIds: [] },
    tools: { disabled: [] },
  }
}

/**
 * Deep-merge a partial onto a base. Arrays are replaced wholesale.
 */
function deepMerge<T extends Record<string, unknown>>(base: T, overlay: Partial<T>): T {
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(overlay ?? {})) {
    if (
      v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      base[k] &&
      typeof base[k] === 'object' &&
      !Array.isArray(base[k])
    ) {
      out[k] = deepMerge(base[k] as Record<string, unknown>, v as Record<string, unknown>)
    } else if (v !== undefined) {
      out[k] = v
    }
  }
  return out as T
}

/**
 * Initialise a new guild dir from defaults.
 *
 * - Creates the dir and data subdirs.
 * - Writes config.json (merging in `opts.config`) only if it does not already exist.
 * - Writes secrets.json with mode 0600, merging in `opts.secrets` if provided.
 * - Seeds tools/, skills/, prompt.md, memory.md from the codebase if absent.
 *
 * Idempotent. Safe to call repeatedly.
 */
export function initGuildDir(guildDir: string, opts: InitGuildDirOptions = {}): void {
  const root = resolve(guildDir)
  const codebaseRoot = opts.codebaseRoot ?? DEFAULT_CODEBASE_ROOT
  const p = paths(root)

  mkdirSync(root, { recursive: true })
  for (const sub of DATA_SUBDIRS) {
    mkdirSync(join(root, sub), { recursive: true })
  }

  // Write config.json if missing
  if (!existsSync(p.config)) {
    const merged = deepMerge(
      defaultConfig() as unknown as Record<string, unknown>,
      (opts.config ?? {}) as Record<string, unknown>,
    )
    // Validate the merged result so callers cannot create an invalid guild
    const parsed = rawGuildConfigSchema.safeParse(merged)
    if (!parsed.success) {
      const lines = parsed.error.issues.map(
        (i) => `  • ${i.path.length ? i.path.join('.') : '<root>'}: ${i.message}`,
      )
      throw new Error(`initGuildDir: merged config is invalid:\n${lines.join('\n')}`)
    }
    writeFileSync(p.config, JSON.stringify(parsed.data, null, 2) + '\n', 'utf8')
  } else if (opts.config) {
    // Merge overrides into the existing config non-destructively
    const existing = JSON.parse(readFileSync(p.config, 'utf8'))
    const merged = deepMerge(existing, opts.config)
    writeFileSync(p.config, JSON.stringify(merged, null, 2) + '\n', 'utf8')
  }

  // Write secrets.json with mode 0600. Always present so the permission check has a file.
  if (!existsSync(p.secrets)) {
    writeFileSync(p.secrets, JSON.stringify(opts.secrets ?? {}, null, 2) + '\n', 'utf8')
    chmodSync(p.secrets, 0o600)
  } else if (opts.secrets) {
    const existing = JSON.parse(readFileSync(p.secrets, 'utf8'))
    const merged = { ...existing, ...opts.secrets }
    writeFileSync(p.secrets, JSON.stringify(merged, null, 2) + '\n', 'utf8')
    chmodSync(p.secrets, 0o600)
  } else {
    // Ensure permissions are right even on existing files
    try {
      chmodSync(p.secrets, 0o600)
    } catch {
      // best effort
    }
  }

  // Resync tools/ and skills/ from the codebase on every initGuildDir call.
  // This keeps the per-guild copy in sync with the running code (handler signatures,
  // schema versions, etc.) without requiring a manual `guildbot sync` after every
  // codebase change. cpSync overwrites matching files but does NOT delete orphans,
  // so any guild-local tools/skills the operator has added are preserved as
  // overlays alongside the codebase set.
  const codebaseTools = join(codebaseRoot, 'tools')
  if (existsSync(codebaseTools)) {
    cpSync(codebaseTools, p.tools, { recursive: true })
  } else {
    mkdirSync(p.tools, { recursive: true })
  }
  const codebaseSkills = join(codebaseRoot, 'skills')
  if (existsSync(codebaseSkills)) {
    cpSync(codebaseSkills, p.skills, { recursive: true })
  } else {
    mkdirSync(p.skills, { recursive: true })
  }

  // Seed prompt.md and memory.md from guild-defaults/ if present and absent in the guild dir
  const promptDefault = join(codebaseRoot, 'guild-defaults', 'prompt.md')
  if (!existsSync(p.prompt) && existsSync(promptDefault)) {
    cpSync(promptDefault, p.prompt)
  }
  const memoryDefault = join(codebaseRoot, 'guild-defaults', 'memory.md')
  if (!existsSync(p.memory) && existsSync(memoryDefault)) {
    cpSync(memoryDefault, p.memory)
  }
}

