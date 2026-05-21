export type ThreadId = string
export type GuildId = string
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool'

export type ThreadMessage = {
  id: string
  seq: number
  role: MessageRole
  content: string
  kind?: 'guild-prompt' | 'standard' | 'compaction'
  toolName?: string
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
  toolCallId?: string
  /**
   * For kind:'compaction' messages: the inclusive [startSeq, endSeq] of the
   * original messages this compaction summary replaces.
   */
  replacesRange?: [number, number]
  /**
   * For kind:'compaction' messages: path (relative to the thread dir) to the
   * archive JSONL containing the original messages.
   */
  archiveRef?: string
  sourceRef?: {
    platform: string
    messageId?: string
    channelId?: string
    userId?: string
  }
  ts: string
}

export type CompactionState = {
  /** Highest seq covered by any compaction message's replacesRange[1]. */
  lastCompactedThroughSeq?: number
  /** Total number of compaction events committed in this thread. */
  compactionCount: number
}

export type ThreadMeta = {
  id: ThreadId
  guildId: GuildId
  createdAt: string
  updatedAt: string
  title?: string
  parent?: { threadId: ThreadId; forkedAfterMessageId: string } | null
  systemContext?: { guildSystemPromptSnapshotPath?: string; modelHint?: string }
  /**
   * Cache of compaction state derived from messages.jsonl. The log is the
   * source of truth — if this field disagrees on load, the loader reconstructs
   * it and lazily rewrites meta.json.
   */
  compactionState?: CompactionState
}

export class ThreadNotFoundError extends Error {
  constructor(public readonly threadId: ThreadId) {
    super(`Thread not found: ${threadId}`)
    this.name = 'ThreadNotFoundError'
  }
}
