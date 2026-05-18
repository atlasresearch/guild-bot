import { addTags } from '@guildbot/message-processor'
import type { ToolHandler } from '@guildbot/types'

const handler: ToolHandler = async (args, _ctx) => {
  const messageId = args.message_id as string
  const tags = args.tags as string[]
  await addTags(messageId, tags)
  return { success: true, data: { message_id: messageId, tags } }
}

export default handler
