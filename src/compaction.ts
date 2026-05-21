// Shared compaction wiring used by the Discord dispatcher and the CLI thread
// chat REPL. Both entry points call `maybeCompactThread` after the agent loop
// returns its final assistant message. This file owns the `structured()` call
// and the memory-write hook; @guildbot/threads stays platform-agnostic.

import { z } from 'zod'
import {
  loadConfig,
  loadMemory,
  renderGuildSystemMessage,
  updateMemory,
} from '@guildbot/guild-config'
import { structured } from '@guildbot/llm'
import {
  maybeCompactThread,
  type CompactorClosure,
  type MaybeCompactResult,
  type ThreadId,
  type ThreadMessage,
} from '@guildbot/threads'

// Schema is intentionally minimal — no ontology, no category enum. The model
// returns the summary and (optionally) the full rewritten memory body. Whatever
// it should aim for comes from prompt.md and memory.md (which the system
// message includes via renderGuildSystemMessage).
export const COMPACTION_SCHEMA = z.object({
  summary: z.string(),
  newMemory: z.string().nullable(),
})

// Framing line is mechanics-only — no scope guidance, no redaction
// instructions, no merge rules. Operators encode guidance in prompt.md /
// memory.md.
export const COMPACTION_FRAMING =
  'You are summarising a thread for storage and updating the guild\'s long-term memory. Return the new `summary` and the new `newMemory` body (or null if no change).'

/** JSON-lines serialisation of the range — one {role, content} per line. */
export function serializeRange(range: ThreadMessage[]): string {
  return range.map((m) => JSON.stringify({ role: m.role, content: m.content })).join('\n')
}

/**
 * Builds a CompactorClosure that calls structured() once and returns
 * { summary, newMemory }. Throws on LLM failure or schema rejection so
 * maybeCompactThread's catch block can warn and skip.
 */
export function buildCompactor(): CompactorClosure {
  return async (range: ThreadMessage[]) => {
    const sys = await renderGuildSystemMessage()
    const r = await structured({
      schema: COMPACTION_SCHEMA,
      schemaName: 'thread_compaction',
      messages: [
        { role: 'system', content: sys.content },
        { role: 'system', content: COMPACTION_FRAMING },
        { role: 'user', content: serializeRange(range) },
      ],
    })
    if (!r.success) {
      throw new Error(`structured() failed: ${r.error}`)
    }
    return { summary: r.data.summary, newMemory: r.data.newMemory }
  }
}

/**
 * Runs `maybeCompactThread` with all per-guild config (thresholds, memory
 * settings) wired in. Returns the result so callers can log it.
 */
export async function runCompactionIfNeeded(
  threadId: ThreadId,
): Promise<MaybeCompactResult> {
  const cfg = loadConfig()
  const currentMemory = await loadMemory()
  return maybeCompactThread(threadId, {
    config: cfg.threads.compaction,
    compactor: buildCompactor(),
    memoryExtractionEnabled: cfg.memory.extractionEnabled,
    currentMemoryBody: currentMemory.content,
    onMemoryUpdate: async (body) => {
      await updateMemory(body, { reason: `compaction:${threadId}` })
    },
  })
}

/** Formats a one-line log message for operator visibility. */
export function formatCompactionLog(threadId: ThreadId, result: MaybeCompactResult): string {
  if (!result.compacted) return ''
  const memStatus = result.memoryStatus ?? 'unchanged'
  return `[compaction] thread ${threadId} compacted (id=${result.compactionId ?? '?'}, memory: ${memStatus})`
}
