import fsp from 'node:fs/promises'
import { atomicWrite } from '@guildbot/interfaces'
import { withThreadLock } from './mutex'
import { threadMessagesFile, threadMetaFile } from './paths'
import { readMessages } from './readMessages'
import { loadThread } from './loadThread'
import type { ThreadId, ThreadMessage, ThreadMeta } from './types'
import { deriveTitle } from './createThread'

export type AppendInput = Omit<ThreadMessage, 'id' | 'seq' | 'ts'>

export async function appendMessage(
  id: ThreadId,
  msg: AppendInput,
): Promise<ThreadMessage> {
  return withThreadLock(id, async () => {
    // Read the raw current log to assign next seq and to rewrite the file
    // atomically without losing compacted originals. Stays inside the lock so
    // concurrent appends are linearised.
    const existing = await readMessages(id, { collapseCompactions: false })
    const nextSeq = existing.length === 0 ? 1 : existing[existing.length - 1].seq + 1
    const now = new Date().toISOString()
    const fullMessage: ThreadMessage = {
      id: `${id}-msg-${nextSeq}`,
      seq: nextSeq,
      ts: now,
      ...msg,
    }
    // Append to JSONL by writing the new full file via atomicWrite. Append-only
    // semantics are preserved at the line level — existing lines are byte-for-byte
    // identical.
    const allLines = [...existing.map((m) => JSON.stringify(m)), JSON.stringify(fullMessage)]
    await atomicWrite(threadMessagesFile(id), allLines.join('\n') + '\n')

    // Update meta.updatedAt; opportunistically populate the title from the
    // first user message if it was a placeholder.
    const meta = await loadThread(id)
    const next: ThreadMeta = { ...meta, updatedAt: now }
    if (
      msg.role === 'user' &&
      (meta.title === undefined || /^Thread \d{4}-\d{2}-\d{2}$/.test(meta.title))
    ) {
      next.title = deriveTitle(msg.content, new Date(now))
    }
    await atomicWrite(threadMetaFile(id), JSON.stringify(next, null, 2) + '\n')
    return fullMessage
  })
}

/** Re-export for callers that need fs-level visibility. */
export const _internal = { fsp }
