import fsp from 'node:fs/promises'
import { atomicWrite } from '@guildbot/interfaces'
import { threadMessagesFile, threadMetaFile } from './paths'
import {
  ThreadNotFoundError,
  type CompactionState,
  type ThreadId,
  type ThreadMessage,
  type ThreadMeta,
} from './types'

function deriveCompactionState(messages: ThreadMessage[]): CompactionState {
  let count = 0
  let lastThrough: number | undefined = undefined
  for (const m of messages) {
    if (m.kind === 'compaction' && m.replacesRange) {
      count++
      const end = m.replacesRange[1]
      if (lastThrough === undefined || end > lastThrough) lastThrough = end
    }
  }
  return lastThrough === undefined
    ? { compactionCount: count }
    : { compactionCount: count, lastCompactedThroughSeq: lastThrough }
}

function compactionStatesEqual(a: CompactionState | undefined, b: CompactionState): boolean {
  if (!a) return b.compactionCount === 0 && b.lastCompactedThroughSeq === undefined
  return (
    a.compactionCount === b.compactionCount &&
    (a.lastCompactedThroughSeq ?? undefined) === (b.lastCompactedThroughSeq ?? undefined)
  )
}

export async function loadThread(id: ThreadId): Promise<ThreadMeta> {
  let raw: string
  try {
    raw = await fsp.readFile(threadMetaFile(id), 'utf8')
  } catch (e: any) {
    if (e?.code === 'ENOENT') throw new ThreadNotFoundError(id)
    throw e
  }
  const meta = JSON.parse(raw) as ThreadMeta

  // Reconstruct compactionState from messages.jsonl if it disagrees with the
  // cached value on meta. The log is the source of truth — a crash between
  // step 2 and step 3 of the compaction write sequence can leave meta stale.
  let messagesRaw: string
  try {
    messagesRaw = await fsp.readFile(threadMessagesFile(id), 'utf8')
  } catch (e: any) {
    if (e?.code === 'ENOENT') return meta
    throw e
  }
  if (!messagesRaw) return meta
  const messages = messagesRaw
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as ThreadMessage)
  const truth = deriveCompactionState(messages)
  if (compactionStatesEqual(meta.compactionState, truth)) return meta

  const reconciled: ThreadMeta = { ...meta, compactionState: truth }
  await atomicWrite(threadMetaFile(id), JSON.stringify(reconciled, null, 2) + '\n')
  return reconciled
}

export { deriveCompactionState }
