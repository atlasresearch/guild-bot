// Public API for @guildbot/threads (plan 005).
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
} from './types'
export { ThreadNotFoundError } from './types'

export { createThread, deriveTitle, type CreateThreadOptions } from './createThread'
export { loadThread } from './loadThread'
export { listThreads, type ListFilter } from './listThreads'
export { appendMessage, type AppendInput } from './appendMessage'
export { readMessages } from './readMessages'
export { forkThread, type ForkOptions } from './forkThread'

// Path helpers — used by the dispatcher to bind attachments to messages.
export {
  threadsRoot,
  threadDir,
  threadMetaFile,
  threadMessagesFile,
  threadAttachmentsDir,
} from './paths'

// Test-only mutex reset.
export { _resetMutexForTests } from './mutex'
