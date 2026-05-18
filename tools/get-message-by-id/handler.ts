import { getMessage } from '@guildbot/database'
import type { ToolHandler } from '@guildbot/types'

const handler: ToolHandler = async (args, _ctx) => {
  const messageId = args.message_id as string
  const message = await getMessage(messageId)
  if (!message) {
    return { success: false, data: { error: `Message ${messageId} not found` } }
  }
  return { success: true, data: message }
}

export default handler
