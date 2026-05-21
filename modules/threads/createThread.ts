import fsp from 'node:fs/promises'
import { ulid } from 'ulid'
import { atomicWrite } from '@guildbot/interfaces'
import {
  threadDir,
  threadMessagesFile,
  threadMetaFile,
} from './paths'
import type { GuildId, ThreadMeta } from './types'

export type CreateThreadOptions = {
  guildId: GuildId
  title?: string
  parent?: ThreadMeta['parent']
  systemContext?: ThreadMeta['systemContext']
}

export function deriveTitle(firstUserMessage?: string, createdAt: Date = new Date()): string {
  if (firstUserMessage) {
    const oneLine = firstUserMessage.replace(/\s+/g, ' ').trim()
    if (oneLine.length > 0) return oneLine.slice(0, 80)
  }
  return `Thread ${createdAt.toISOString().slice(0, 10)}`
}

export async function createThread(opts: CreateThreadOptions): Promise<ThreadMeta> {
  const id = ulid()
  const now = new Date()
  const meta: ThreadMeta = {
    id,
    guildId: opts.guildId,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    title: opts.title ?? deriveTitle(undefined, now),
    parent: opts.parent ?? null,
    systemContext: opts.systemContext,
  }
  await fsp.mkdir(threadDir(id), { recursive: true })
  await atomicWrite(threadMetaFile(id), JSON.stringify(meta, null, 2) + '\n')
  // Create empty messages file so readMessages on a fresh thread succeeds.
  await atomicWrite(threadMessagesFile(id), '')
  return meta
}
