// Public API for @guildbot/threads (plan 005 + compaction extensions from 008).
//
// Threads are files on disk under <GUILD_DIR>/threads/<threadId>/. This module
// is platform-agnostic: it knows nothing about Discord. Platform-specific
// mapping (Discord <-> threadId) lives in @guildbot/discord-index.

export type {
  ThreadId,
  GuildId,
  MessageRole,
  ThreadMessage,
  ThreadMeta,
  CompactionState,
} from './types'
export { ThreadNotFoundError } from './types'

export { createThread, deriveTitle, type CreateThreadOptions } from './createThread'
export { loadThread } from './loadThread'
export { listThreads, type ListFilter } from './listThreads'
export { appendMessage, type AppendInput } from './appendMessage'
export { readMessages, type ReadMessagesOptions } from './readMessages'
export { forkThread, type ForkOptions } from './forkThread'

// Plan 008 — compaction
export { estimateTokens } from './estimateTokens'
export { compactThread, type CompactThreadOptions } from './compactThread'
export {
  maybeCompactThread,
  type MaybeCompactOptions,
  type MaybeCompactResult,
  type CompactionConfig,
  type CompactorClosure,
  type OnMemoryUpdate,
} from './maybeCompactThread'

// Path helpers — used by the dispatcher to bind attachments to messages.
export {
  threadsRoot,
  threadDir,
  threadMetaFile,
  threadMessagesFile,
  threadAttachmentsDir,
  threadArchiveDir,
  threadArchiveFile,
} from './paths'

// Test-only mutex reset.
export { _resetMutexForTests } from './mutex'
