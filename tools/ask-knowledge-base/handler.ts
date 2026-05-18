import { ask } from '@guildbot/rag'
import type { ToolHandler } from '@guildbot/types'

const handler: ToolHandler = async (args, ctx) => {
  const question = args.question as string
  const answer = await ask(ctx.guildId ?? '', question)
  return { success: true, data: { answer } }
}

export default handler
