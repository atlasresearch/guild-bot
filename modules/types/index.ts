// Tool type re-exported from @guildbot/llm so consumers don't reach for ollama directly.
export type { LlmTool as Tool } from '@guildbot/llm'

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
