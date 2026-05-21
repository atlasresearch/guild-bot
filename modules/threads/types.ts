export type ThreadId = string
export type GuildId = string
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool'

export type ThreadMessage = {
  id: string
  seq: number
  role: MessageRole
  content: string
  kind?: 'guild-prompt' | 'standard'
  toolName?: string
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
  toolCallId?: string
  sourceRef?: {
    platform: string
    messageId?: string
    channelId?: string
    userId?: string
  }
  ts: string
}

export type ThreadMeta = {
  id: ThreadId
  guildId: GuildId
  createdAt: string
  updatedAt: string
  title?: string
  parent?: { threadId: ThreadId; forkedAfterMessageId: string } | null
  systemContext?: { guildSystemPromptSnapshotPath?: string; modelHint?: string }
}

export class ThreadNotFoundError extends Error {
  constructor(public readonly threadId: ThreadId) {
    super(`Thread not found: ${threadId}`)
    this.name = 'ThreadNotFoundError'
  }
}
