import { audioToTranscript } from '@guildbot/media'
import type { ToolHandler } from '@guildbot/types'

const handler: ToolHandler = async (args, ctx) => {
  const url = args.url as string
  const recordingId = await audioToTranscript(url, ctx.onProgress)
  return { success: true, data: { transcript: recordingId, recording_id: recordingId } }
}

export default handler
