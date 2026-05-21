import fsp from 'node:fs/promises'
import { threadMessagesFile } from './paths'
import { ThreadNotFoundError, type ThreadId, type ThreadMessage } from './types'

export type ReadMessagesOptions = {
  /**
   * When true (default), compaction messages stand in for the ranges they
   * replace. When false, the raw JSONL is returned (used by forking, debugging,
   * and meta-cache reconstruction).
   */
  collapseCompactions?: boolean
}

export async function readMessages(
  id: ThreadId,
  opts: ReadMessagesOptions = {},
): Promise<ThreadMessage[]> {
  const collapse = opts.collapseCompactions !== false
  let raw: string
  try {
    raw = await fsp.readFile(threadMessagesFile(id), 'utf8')
  } catch (e: any) {
    if (e?.code === 'ENOENT') throw new ThreadNotFoundError(id)
    throw e
  }
  if (!raw) return []
  const all = raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as ThreadMessage)

  if (!collapse) return all

  // Collapse: drop any message whose seq falls inside any compaction's
  // replacesRange. Compaction messages take the position of their
  // replacesRange[0] so the summary stands "in place" of the originals.
  const ranges: Array<[number, number]> = []
  for (const m of all) {
    if (m.kind === 'compaction' && m.replacesRange) ranges.push(m.replacesRange)
  }
  if (ranges.length === 0) return all

  const kept = all.filter((m) => {
    if (m.kind === 'compaction') return true
    for (const [s, e] of ranges) {
      if (m.seq >= s && m.seq <= e) return false
    }
    return true
  })

  // Position key: replacesRange[0] for compactions, seq for standard.
  // Stable sort keeps original order on ties (e.g., a standard at seq=N
  // never ties with a compaction whose replacesRange[0]=N — that would mean
  // the standard is in the compaction's range and was filtered out).
  return [...kept]
    .map((m, i) => ({
      m,
      key:
        m.kind === 'compaction' && m.replacesRange
          ? m.replacesRange[0]
          : m.seq,
      idx: i,
    }))
    .sort((a, b) => (a.key !== b.key ? a.key - b.key : a.idx - b.idx))
    .map((entry) => entry.m)
}
