import fsp from 'node:fs/promises'
import { threadMessagesFile } from './paths'
import { ThreadNotFoundError, type ThreadId, type ThreadMessage } from './types'

export async function readMessages(id: ThreadId): Promise<ThreadMessage[]> {
  let raw: string
  try {
    raw = await fsp.readFile(threadMessagesFile(id), 'utf8')
  } catch (e: any) {
    if (e?.code === 'ENOENT') throw new ThreadNotFoundError(id)
    throw e
  }
  if (!raw) return []
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as ThreadMessage)
}
