import { search } from '@guildbot/rag'
import type { ToolHandler } from '@guildbot/types'

const handler: ToolHandler = async (args, ctx) => {
  const query = args.query as string
  const limit = (args.limit as number) ?? 5
  const results = await search(ctx.guildId ?? '', query, limit)
  const cleaned = (results as Record<string, unknown>[]).map(({ vector, ...rest }) => rest)
  return { success: true, data: cleaned }
}

export default handler
