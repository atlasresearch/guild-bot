import { join } from 'node:path'
import { paths as guildPaths } from '@guildbot/guild-config'
import type { ThreadId } from './types'

export function threadsRoot(): string {
  return guildPaths().threads
}

export function threadDir(id: ThreadId): string {
  return join(threadsRoot(), id)
}

export function threadMetaFile(id: ThreadId): string {
  return join(threadDir(id), 'meta.json')
}

export function threadMessagesFile(id: ThreadId): string {
  return join(threadDir(id), 'messages.jsonl')
}

export function threadAttachmentsDir(id: ThreadId): string {
  return join(threadDir(id), 'attachments')
}

export function threadArchiveDir(id: ThreadId): string {
  return join(threadDir(id), 'archive')
}

export function threadArchiveFile(id: ThreadId, compactionId: string): string {
  return join(threadArchiveDir(id), `${compactionId}.jsonl`)
}
