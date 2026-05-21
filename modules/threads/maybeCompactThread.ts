// maybeCompactThread owns the threshold check. Both the Discord dispatcher and
// the CLI REPL call this after the agent loop returns its final assistant
// message. The threads module stays platform-agnostic — the compactor closure
// (which calls @guildbot/llm) and the onMemoryUpdate closure (which calls
// @guildbot/guild-config's updateMemory) are injected by the caller.

import { compactThread } from './compactThread'
import { estimateTokens } from './estimateTokens'
import { readMessages } from './readMessages'
import type { ThreadId, ThreadMessage } from './types'

export type CompactionConfig = {
  thresholdMessages: number
  thresholdTokens: number
  keepLastN: number
}

export type CompactorClosure = (
  range: ThreadMessage[],
) => Promise<{ summary: string; newMemory: string | null }>

export type OnMemoryUpdate = (body: string) => Promise<void>

export type MaybeCompactOptions = {
  config: CompactionConfig
  compactor: CompactorClosure
  /**
   * Hook for writing the rewritten memory body. Caller wraps updateMemory()
   * from @guildbot/guild-config so the threads module stays platform-agnostic.
   * MUST throw on validator rejection — maybeCompactThread catches and logs.
   */
  onMemoryUpdate?: OnMemoryUpdate
  /**
   * Optional: when false, skip the memory write entirely (compaction summary
   * still lands). Mirrors config.memory.extractionEnabled.
   */
  memoryExtractionEnabled?: boolean
  /**
   * Optional: current memory body, byte-for-byte. Used to no-op when newMemory
   * matches. Caller passes loadMemory().content.
   */
  currentMemoryBody?: string
}

export type MaybeCompactResult = {
  compacted: boolean
  compactionId?: string
  /** One of: 'updated' | 'unchanged' | 'skipped' | 'disabled'. Only set when compacted=true. */
  memoryStatus?: 'updated' | 'unchanged' | 'skipped' | 'disabled'
}

export async function maybeCompactThread(
  id: ThreadId,
  opts: MaybeCompactOptions,
): Promise<MaybeCompactResult> {
  const collapsed = await readMessages(id, { collapseCompactions: true })
  if (collapsed.length === 0) return { compacted: false }

  const messageCount = collapsed.length
  const tokenCount = estimateTokens(collapsed)
  const overByMessages = messageCount > opts.config.thresholdMessages
  const overByTokens = tokenCount > opts.config.thresholdTokens
  if (!overByMessages && !overByTokens) return { compacted: false }

  // Compute the range to compact from the raw log.
  const raw = await readMessages(id, { collapseCompactions: false })
  let lastCompactedThrough = 0
  for (const m of raw) {
    if (m.kind === 'compaction' && m.replacesRange) {
      const end = m.replacesRange[1]
      if (end > lastCompactedThrough) lastCompactedThrough = end
    }
  }
  const currentMaxSeq = raw.length > 0 ? raw[raw.length - 1].seq : 0
  const startSeq = lastCompactedThrough + 1
  const endSeq = currentMaxSeq - opts.config.keepLastN

  if (startSeq > endSeq) return { compacted: false }

  const range = raw.filter((m) => m.seq >= startSeq && m.seq <= endSeq)
  if (range.length === 0) return { compacted: false }

  // Run the LLM call. Any failure aborts the compaction; we warn and return.
  let summary: string
  let newMemory: string | null
  try {
    const result = await opts.compactor(range)
    summary = result.summary
    newMemory = result.newMemory
  } catch (e: any) {
    console.warn(
      `[compaction] thread ${id}: compactor failed; skipping. error=${e?.message ?? e}`,
    )
    return { compacted: false }
  }
  if (typeof summary !== 'string' || summary.length === 0) {
    console.warn(
      `[compaction] thread ${id}: compactor returned empty/invalid summary; skipping.`,
    )
    return { compacted: false }
  }

  // Commit the summary. Throws if the file dance fails — we don't catch here
  // because that's a storage failure, not an LLM failure.
  const compactionMsg = await compactThread(id, { throughSeq: endSeq, summary })
  const compactionId = compactionMsg.archiveRef?.replace(/^archive\//, '').replace(/\.jsonl$/, '')

  // Memory write — best-effort. Validator rejection is logged but never aborts.
  let memoryStatus: MaybeCompactResult['memoryStatus'] = 'unchanged'
  if (opts.memoryExtractionEnabled === false) {
    memoryStatus = 'disabled'
  } else if (newMemory === null || newMemory === undefined) {
    memoryStatus = 'unchanged'
  } else if (
    opts.currentMemoryBody !== undefined &&
    newMemory === opts.currentMemoryBody
  ) {
    memoryStatus = 'unchanged'
  } else if (!opts.onMemoryUpdate) {
    memoryStatus = 'skipped'
  } else {
    try {
      await opts.onMemoryUpdate(newMemory)
      memoryStatus = 'updated'
    } catch (e: any) {
      console.warn(
        `[compaction] thread ${id}: memory update rejected; compaction summary kept. error=${e?.message ?? e}`,
      )
      memoryStatus = 'skipped'
    }
  }

  return { compacted: true, compactionId, memoryStatus }
}
