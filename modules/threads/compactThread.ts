// compactThread performs the on-disk file dance for a single compaction event:
//   1. Write archive/<compactionId>.jsonl (the original messages being replaced)
//   2. Append the kind:'compaction' message to messages.jsonl (commit point)
//   3. Rewrite meta.json with the updated compactionState
//
// The LLM call that produces the summary is NOT here — `maybeCompactThread`
// owns that. compactThread is pure file plumbing.

import { mkdir } from 'node:fs/promises'
import { ulid } from 'ulid'
import { atomicWrite } from '@guildbot/interfaces'
import { withThreadLock } from './mutex'
import { loadThread, deriveCompactionState } from './loadThread'
import {
  threadArchiveDir,
  threadArchiveFile,
  threadMessagesFile,
  threadMetaFile,
} from './paths'
import { readMessages } from './readMessages'
import type { ThreadId, ThreadMessage, ThreadMeta } from './types'

export type CompactThreadOptions = {
  /** Inclusive end seq of the range to compact. Start is derived from prior compactions. */
  throughSeq: number
  /** The summary text produced by the LLM. */
  summary: string
}

export async function compactThread(
  id: ThreadId,
  opts: CompactThreadOptions,
): Promise<ThreadMessage> {
  return withThreadLock(id, async () => {
    // Snapshot raw log; we need both the rangle being compacted and the next
    // seq for the new compaction message.
    const all = await readMessages(id, { collapseCompactions: false })

    // Determine startSeq: one past the highest seq already compacted.
    const state = deriveCompactionState(all)
    const startSeq = (state.lastCompactedThroughSeq ?? 0) + 1
    const endSeq = opts.throughSeq
    if (endSeq < startSeq) {
      throw new Error(
        `compactThread: empty range startSeq=${startSeq} > endSeq=${endSeq} (nothing to compact)`,
      )
    }

    const rangeMessages = all.filter((m) => m.seq >= startSeq && m.seq <= endSeq)
    if (rangeMessages.length === 0) {
      throw new Error(
        `compactThread: no messages found in range [${startSeq}, ${endSeq}] — log truncated?`,
      )
    }

    const compactionId = ulid()

    // Step 1: archive snapshot. atomicWrite + mkdir on the archive directory.
    await mkdir(threadArchiveDir(id), { recursive: true })
    const archivePath = threadArchiveFile(id, compactionId)
    const archiveBody = rangeMessages.map((m) => JSON.stringify(m)).join('\n') + '\n'
    await atomicWrite(archivePath, archiveBody)

    // Step 2: append the compaction message — this is the commit point.
    const nextSeq = all.length === 0 ? 1 : all[all.length - 1].seq + 1
    const now = new Date().toISOString()
    const compactionMessage: ThreadMessage = {
      id: `${id}-msg-${nextSeq}`,
      seq: nextSeq,
      role: 'system',
      kind: 'compaction',
      content: opts.summary,
      replacesRange: [startSeq, endSeq],
      archiveRef: `archive/${compactionId}.jsonl`,
      ts: now,
    }
    const newLog =
      all.map((m) => JSON.stringify(m)).concat(JSON.stringify(compactionMessage)).join('\n') + '\n'
    await atomicWrite(threadMessagesFile(id), newLog)

    // Step 3: update meta. Loader will reconstruct on the next read if this
    // step is skipped due to a crash.
    const meta = await loadThread(id)
    const nextMeta: ThreadMeta = {
      ...meta,
      updatedAt: now,
      compactionState: {
        compactionCount: (meta.compactionState?.compactionCount ?? 0) + 1,
        lastCompactedThroughSeq: endSeq,
      },
    }
    await atomicWrite(threadMetaFile(id), JSON.stringify(nextMeta, null, 2) + '\n')

    return compactionMessage
  })
}
