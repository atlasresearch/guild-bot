import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { RECORDINGS_DIR } from '@guildbot/config'
import type { ToolHandler } from '@guildbot/types'

const handler: ToolHandler = async (args, _ctx) => {
  const recordingId = args.recording_id as string | undefined
  const vttPath = recordingId
    ? join(RECORDINGS_DIR, recordingId, 'audio.vtt')
    : join(RECORDINGS_DIR, 'latest', 'audio.vtt')
  const transcript = await readFile(vttPath, 'utf-8')
  return { success: true, data: { transcript, recording_id: recordingId } }
}

export default handler
