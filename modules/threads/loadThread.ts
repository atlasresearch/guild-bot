import fsp from 'node:fs/promises'
import { threadMetaFile } from './paths'
import { ThreadNotFoundError, type ThreadId, type ThreadMeta } from './types'

export async function loadThread(id: ThreadId): Promise<ThreadMeta> {
  try {
    const raw = await fsp.readFile(threadMetaFile(id), 'utf8')
    return JSON.parse(raw) as ThreadMeta
  } catch (e: any) {
    if (e?.code === 'ENOENT') throw new ThreadNotFoundError(id)
    throw e
  }
}
