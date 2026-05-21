import fsp from 'node:fs/promises'
import { join } from 'node:path'
import { threadsRoot } from './paths'
import type { GuildId, ThreadMeta } from './types'

export type ListFilter = {
  guildId?: GuildId
  updatedSince?: string
}

export async function listThreads(filter: ListFilter = {}): Promise<ThreadMeta[]> {
  const root = threadsRoot()
  let entries: string[]
  try {
    entries = await fsp.readdir(root)
  } catch (e: any) {
    if (e?.code === 'ENOENT') return []
    throw e
  }
  const out: ThreadMeta[] = []
  for (const name of entries) {
    if (name === 'index') continue
    const metaPath = join(root, name, 'meta.json')
    try {
      const raw = await fsp.readFile(metaPath, 'utf8')
      const meta = JSON.parse(raw) as ThreadMeta
      if (filter.guildId && meta.guildId !== filter.guildId) continue
      if (filter.updatedSince && meta.updatedAt < filter.updatedSince) continue
      out.push(meta)
    } catch {
      // Skip unreadable entries; not every dir under threads/ is a thread.
    }
  }
  // ULIDs sort lexicographically by creation time.
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return out
}
