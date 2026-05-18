import { downloadYoutubeSingleWithInfo } from '@guildbot/media'
import type { ToolHandler } from '@guildbot/types'

const handler: ToolHandler = async (args, _ctx) => {
  const url = args.url as string
  const result = await downloadYoutubeSingleWithInfo(url, '')
  return { success: true, data: { audio_path: result, metadata: {} } }
}

export default handler
