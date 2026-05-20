import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { paths } from '@guildbot/guild-config'
import type { ToolHandler } from '@guildbot/types'

const handler: ToolHandler = async (args, _ctx) => {
  const recordingId = args.recording_id as string | undefined
  const recordingsDir = paths().recordings
  const vttPath = recordingId
    ? join(recordingsDir, recordingId, 'audio.vtt')
    : join(recordingsDir, 'latest', 'audio.vtt')
  const transcript = await readFile(vttPath, 'utf-8')
  return { success: true, data: { transcript, recording_id: recordingId } }
}

export default handler
