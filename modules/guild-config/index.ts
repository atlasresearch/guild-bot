// Public API for the per-guild config module (plan 003).
//
// loadConfig() reads config.json + secrets.json from disk on EVERY call.
// Callers MUST NOT cache the returned object across operations.

export { loadConfig, ConfigError } from './loadConfig'
export { paths, DATA_SUBDIRS, type GuildPaths } from './paths'
export {
  resolveGuildDir,
  resolveGuildDirOrThrow,
  parseGuildDirArg,
  GuildDirNotFoundError,
} from './resolveGuildDir'
export { initGuildDir, type InitGuildDirOptions } from './initGuildDir'
export { syncFromCodebase, type SyncOptions } from './syncFromCodebase'
export type {
  GuildConfig,
  RawGuildConfig,
  LlmProvider,
  LlmDialect,
  SecretRef,
  SecretsFile,
} from './schema'
export { isSecretRef } from './schema'

// plan 007 — per-guild prompt + memory
export {
  loadPrompt,
  loadMemory,
  updatePrompt,
  updateMemory,
  renderGuildSystemMessage,
  unifiedDiff,
  CANONICAL_MEMORY_HEADINGS,
  type GuildPrompt,
  type GuildMemory,
  type UpdateOptions,
  type RenderedGuildSystemMessage,
} from './promptMemory'
export {
  parseFrontmatter,
  serializeWithFrontmatter,
  type Frontmatter,
  type ParsedFile,
} from './frontmatter'
export {
  listHistory,
  revert,
  defaultPath,
  diffAgainstDefault,
  forgetMemory,
  type HistoryEntry,
  type ForgetResult,
} from './promptMemoryOps'
