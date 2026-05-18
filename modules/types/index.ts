export type { Tool } from 'ollama'

export type ToolContext = {
  guildId?: string
  channelId?: string
  userId?: string
  sessionDir?: string
  onProgress?: (msg: string) => void
}

export type ToolResult = {
  success: boolean
  data: unknown
  summary?: string
}

export type ToolHandler = (
  args: Record<string, unknown>,
  context: ToolContext
) => Promise<ToolResult>
