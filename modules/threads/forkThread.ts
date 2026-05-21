import fsp from 'node:fs/promises'
import { join } from 'node:path'
import { ulid } from 'ulid'
import { atomicWrite } from '@guildbot/interfaces'
import { loadThread } from './loadThread'
import { readMessages } from './readMessages'
import {
  threadAttachmentsDir,
  threadDir,
  threadMessagesFile,
  threadMetaFile,
} from './paths'
import { type ThreadId, type ThreadMessage, type ThreadMeta } from './types'

export type ForkOptions = {
  title?: string
}

export async function forkThread(
  sourceId: ThreadId,
  afterMessageId: string,
  opts: ForkOptions = {},
): Promise<ThreadMeta> {
  const sourceMeta = await loadThread(sourceId) // throws ThreadNotFoundError
  const sourceMessages = await readMessages(sourceId)
  const fork = sourceMessages.find((m) => m.id === afterMessageId)
  if (!fork) {
    throw new Error(`Fork point not found in ${sourceId}: ${afterMessageId}`)
  }
  const cutoff = fork.seq

  const newId = ulid()
  const now = new Date().toISOString()
  const newMeta: ThreadMeta = {
    id: newId,
    guildId: sourceMeta.guildId,
    createdAt: now,
    updatedAt: now,
    title: opts.title ?? sourceMeta.title,
    parent: { threadId: sourceId, forkedAfterMessageId: afterMessageId },
    systemContext: sourceMeta.systemContext,
  }

  const forkedMessages = sourceMessages
    .filter((m) => m.seq <= cutoff)
    .map<ThreadMessage>((m) => ({ ...m, id: `${newId}-msg-${m.seq}` }))

  await fsp.mkdir(threadDir(newId), { recursive: true })
  await atomicWrite(threadMetaFile(newId), JSON.stringify(newMeta, null, 2) + '\n')
  await atomicWrite(
    threadMessagesFile(newId),
    forkedMessages.length > 0
      ? forkedMessages.map((m) => JSON.stringify(m)).join('\n') + '\n'
      : '',
  )

  // Copy referenced attachments. We mirror by source message id since the dir
  // layout uses message ids as subfolder names.
  const srcAttachmentsRoot = threadAttachmentsDir(sourceId)
  const dstAttachmentsRoot = threadAttachmentsDir(newId)
  for (const m of sourceMessages) {
    if (m.seq > cutoff) continue
    const srcMsgDir = join(srcAttachmentsRoot, m.id)
    try {
      const stat = await fsp.stat(srcMsgDir)
      if (!stat.isDirectory()) continue
    } catch (e: any) {
      if (e?.code === 'ENOENT') continue
      throw e
    }
    // The forked message has a new id; copy to the matching new-id folder.
    const newMsgId = `${newId}-msg-${m.seq}`
    const dstMsgDir = join(dstAttachmentsRoot, newMsgId)
    await fsp.mkdir(dstMsgDir, { recursive: true })
    await fsp.cp(srcMsgDir, dstMsgDir, { recursive: true })
  }

  return newMeta
}

export { ThreadNotFoundError } from './types'
