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
