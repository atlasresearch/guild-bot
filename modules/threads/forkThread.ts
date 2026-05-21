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
  threadArchiveFile,
} from './paths'
import { type ThreadId, type ThreadMessage, type ThreadMeta } from './types'

export type ForkOptions = {
  title?: string
}

/**
 * Forks a thread at `afterMessageId`. Algorithm:
 *
 *   1. Locate the message in the source. If it lives only in an archive
 *      snapshot, fall through and look there too.
 *   2. Compute cutoff = fork.seq.
 *   3. For each compaction message in the raw log whose replacesRange[1] <= cutoff
 *      (entirely before fork point) OR [S, cutoff] straddles cutoff
 *      (S <= cutoff < E), the originals are read from the corresponding
 *      `archive/<compactionId>.jsonl` and inserted into the fork. The
 *      compaction message itself is dropped — the fork has the originals so
 *      no summary is needed.
 *   4. Non-compaction messages with seq <= cutoff that are not covered by any
 *      compaction's replacesRange are picked from the raw log.
 *   5. Re-id + re-seq contiguously starting at 1. Copy attachments under the
 *      new message ids.
 */
export async function forkThread(
  sourceId: ThreadId,
  afterMessageId: string,
  opts: ForkOptions = {},
): Promise<ThreadMeta> {
  const sourceMeta = await loadThread(sourceId) // throws ThreadNotFoundError
  const sourceRaw = await readMessages(sourceId, { collapseCompactions: false })

  // Load each compaction's archive eagerly (small files, bounded count).
  const compactionToArchive = new Map<string, ThreadMessage[]>()
  for (const m of sourceRaw) {
    if (m.kind !== 'compaction' || !m.archiveRef) continue
    const compactionId = m.archiveRef.replace(/^archive\//, '').replace(/\.jsonl$/, '')
    try {
      const raw = await fsp.readFile(threadArchiveFile(sourceId, compactionId), 'utf8')
      const list: ThreadMessage[] = raw
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as ThreadMessage)
      compactionToArchive.set(m.archiveRef, list)
    } catch {
      // Missing archive (e.g., test fixture or corruption). Fall back to
      // raw-log originals later.
    }
  }

  // Resolve fork point. First try the raw log; then fall back to archived
  // ids (future-proofs against truncation).
  let fork: ThreadMessage | undefined = sourceRaw.find((m) => m.id === afterMessageId)
  if (!fork) {
    for (const archived of compactionToArchive.values()) {
      const hit = archived.find((a) => a.id === afterMessageId)
      if (hit) {
        fork = hit
        break
      }
    }
  }
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

  // Build the union of compaction ranges that cover seqs <= cutoff. We use
  // these to (a) provide the archived originals for those seqs and (b) skip
  // raw-log duplicates of those seqs.
  type RangeWithArchive = { start: number; end: number; archive: ThreadMessage[] }
  const archivedRanges: RangeWithArchive[] = []
  for (const m of sourceRaw) {
    if (m.kind !== 'compaction' || !m.replacesRange || !m.archiveRef) continue
    const [s, e] = m.replacesRange
    if (s > cutoff) continue
    const archive = compactionToArchive.get(m.archiveRef) ?? []
    archivedRanges.push({ start: s, end: Math.min(e, cutoff), archive })
  }

  function isInsideAnyArchivedRange(seq: number): boolean {
    for (const r of archivedRanges) {
      if (seq >= r.start && seq <= r.end) return true
    }
    return false
  }

  // Picks come from two sources:
  //   (1) archived ranges (the canonical source for compacted originals)
  //   (2) raw-log non-compaction messages with seq <= cutoff and outside any
  //       archived range
  type Pick = { src: ThreadMessage; srcSeq: number }
  const picks: Pick[] = []
  for (const r of archivedRanges) {
    for (const a of r.archive) {
      if (a.seq >= r.start && a.seq <= r.end) {
        picks.push({ src: a, srcSeq: a.seq })
      }
    }
  }
  // If the fork point itself is archived-only (not in raw log) and the loops
  // above somehow missed it (e.g., archive file unreadable), include it
  // defensively.
  if (!sourceRaw.some((m) => m.id === afterMessageId) &&
      !picks.some((p) => p.src.id === afterMessageId)) {
    picks.push({ src: fork, srcSeq: fork.seq })
  }
  for (const m of sourceRaw) {
    if (m.kind === 'compaction') continue
    if (m.seq > cutoff) continue
    if (isInsideAnyArchivedRange(m.seq)) continue
    picks.push({ src: m, srcSeq: m.seq })
  }
  picks.sort((a, b) => a.srcSeq - b.srcSeq)

  // Re-id + re-seq contiguously starting at 1.
  const retained: ThreadMessage[] = picks.map((p, i) => ({
    ...p.src,
    id: `${newId}-msg-${i + 1}`,
    seq: i + 1,
  }))

  await fsp.mkdir(threadDir(newId), { recursive: true })
  await atomicWrite(threadMetaFile(newId), JSON.stringify(newMeta, null, 2) + '\n')
  await atomicWrite(
    threadMessagesFile(newId),
    retained.length > 0
      ? retained.map((m) => JSON.stringify(m)).join('\n') + '\n'
      : '',
  )

  // Copy attachments. Source attachments live under `<srcAttachmentsRoot>/<src.id>/`.
  // The forked message has a new id, so we copy to `<dstAttachmentsRoot>/<newMsgId>/`.
  const srcAttachmentsRoot = threadAttachmentsDir(sourceId)
  const dstAttachmentsRoot = threadAttachmentsDir(newId)
  for (let i = 0; i < picks.length; i++) {
    const { src } = picks[i]
    const newSeq = i + 1
    const srcMsgDir = join(srcAttachmentsRoot, src.id)
    try {
      const stat = await fsp.stat(srcMsgDir)
      if (!stat.isDirectory()) continue
    } catch (e: any) {
      if (e?.code === 'ENOENT') continue
      throw e
    }
    const newMsgId = `${newId}-msg-${newSeq}`
    const dstMsgDir = join(dstAttachmentsRoot, newMsgId)
    await fsp.mkdir(dstMsgDir, { recursive: true })
    await fsp.cp(srcMsgDir, dstMsgDir, { recursive: true })
  }

  return newMeta
}

export { ThreadNotFoundError } from './types'
