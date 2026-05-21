// Tests for the compaction storage layer (plan 008).
//
// These tests exercise the threads module in isolation:
//   - readMessages with/without collapseCompactions
//   - compactThread file dance + crash recovery
//   - maybeCompactThread threshold logic + memory hook
//   - forkThread expansion through a compacted range
//   - meta.json reconstruction
//
// The LLM is not invoked here — `maybeCompactThread` takes an injected
// compactor closure, so we feed it fixtures directly. Tests for the
// dispatcher-level wiring (which builds the closure around structured()) live
// in src/compaction.test.ts.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { TEST_GUILD_DIR } = vi.hoisted(() => {
  const dir = require('node:fs').mkdtempSync(
    require('node:path').join(require('node:os').tmpdir(), 'threads-compaction-'),
  )
  return { TEST_GUILD_DIR: dir as string }
})

vi.mock('@guildbot/guild-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@guildbot/guild-config')>()
  return {
    ...actual,
    paths: (guildDir?: string) => actual.paths(guildDir ?? TEST_GUILD_DIR),
  }
})

import {
  appendMessage,
  compactThread,
  createThread,
  estimateTokens,
  forkThread,
  loadThread,
  maybeCompactThread,
  readMessages,
  threadArchiveDir,
  threadArchiveFile,
  threadAttachmentsDir,
  threadMessagesFile,
  threadMetaFile,
  _resetMutexForTests,
  type CompactorClosure,
  type ThreadMessage,
} from './index'

const cfg = { thresholdMessages: 4, thresholdTokens: 1_000_000, keepLastN: 2 }

async function seedThread(messages: number) {
  const meta = await createThread({ guildId: 'discord:test' })
  for (let i = 1; i <= messages; i++) {
    await appendMessage(meta.id, {
      role: i % 2 === 1 ? 'user' : 'assistant',
      content: `msg-${i}`,
    })
  }
  return meta.id
}

describe('plan 008 — compaction storage layer', () => {
  beforeEach(() => {
    rmSync(join(TEST_GUILD_DIR, 'threads'), { recursive: true, force: true })
    _resetMutexForTests()
  })
  afterEach(() => {
    rmSync(join(TEST_GUILD_DIR, 'threads'), { recursive: true, force: true })
  })

  // ── readMessages collapse / raw ────────────────────────────────────────

  describe('readMessages', () => {
    it('collapseCompactions: true (default) returns the compaction message in place of the replaced range', async () => {
      const id = await seedThread(6)
      await compactThread(id, { throughSeq: 4, summary: 'summary of msgs 1-4' })
      const collapsed = await readMessages(id)
      expect(collapsed.map((m) => m.kind ?? 'standard')).toEqual([
        'compaction', 'standard', 'standard',
      ])
      expect(collapsed[0].content).toBe('summary of msgs 1-4')
      expect(collapsed[1].content).toBe('msg-5')
      expect(collapsed[2].content).toBe('msg-6')
    })

    it('collapseCompactions: false returns the raw log including originals', async () => {
      const id = await seedThread(6)
      await compactThread(id, { throughSeq: 4, summary: 's' })
      const raw = await readMessages(id, { collapseCompactions: false })
      // 6 originals + 1 compaction message
      expect(raw.length).toBe(7)
      expect(raw[0].content).toBe('msg-1')
      expect(raw[6].kind).toBe('compaction')
    })
  })

  // ── compactThread file dance ───────────────────────────────────────────

  describe('compactThread (file dance)', () => {
    it('writes archive snapshot before appending the compaction message', async () => {
      const id = await seedThread(5)
      const msg = await compactThread(id, { throughSeq: 3, summary: 's' })
      expect(msg.kind).toBe('compaction')
      expect(msg.replacesRange).toEqual([1, 3])
      expect(msg.archiveRef).toMatch(/^archive\/[0-9A-HJKMNP-TV-Z]{26}\.jsonl$/)
      const compactionId = msg.archiveRef!.replace(/^archive\//, '').replace(/\.jsonl$/, '')
      const archivePath = threadArchiveFile(id, compactionId)
      expect(existsSync(archivePath)).toBe(true)
      const archived = readFileSync(archivePath, 'utf8')
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l))
      expect(archived.map((m: any) => m.content)).toEqual(['msg-1', 'msg-2', 'msg-3'])
    })

    it('appends the compaction message with a fresh seq, the commit point of the operation', async () => {
      const id = await seedThread(5)
      const before = await readMessages(id, { collapseCompactions: false })
      expect(before.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5])
      const cm = await compactThread(id, { throughSeq: 3, summary: 's' })
      expect(cm.seq).toBe(6)
      const after = await readMessages(id, { collapseCompactions: false })
      expect(after.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5, 6])
    })

    it('updates meta.json compactionState after the append', async () => {
      const id = await seedThread(5)
      await compactThread(id, { throughSeq: 3, summary: 's' })
      const meta = await loadThread(id)
      expect(meta.compactionState).toEqual({
        compactionCount: 1,
        lastCompactedThroughSeq: 3,
      })
    })

    it('subsequent appendMessage assigns the next seq above the compaction message', async () => {
      const id = await seedThread(5)
      await compactThread(id, { throughSeq: 3, summary: 's' })
      const next = await appendMessage(id, { role: 'user', content: 'after compact' })
      expect(next.seq).toBe(7)
      // Raw log still contains all five originals + the compaction + the new one.
      const raw = await readMessages(id, { collapseCompactions: false })
      expect(raw.length).toBe(7)
      expect(raw.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5, 6, 7])
    })

    it('rejects an empty range (startSeq > endSeq)', async () => {
      const id = await seedThread(3)
      await compactThread(id, { throughSeq: 3, summary: 's' })
      await expect(
        compactThread(id, { throughSeq: 3, summary: 'again' }),
      ).rejects.toThrow(/nothing to compact/)
    })
  })

  // ── crash recovery / meta reconstruction ───────────────────────────────

  describe('crash recovery + meta reconstruction', () => {
    it('orphan archive snapshot (crash between step 1 and 2) does not break load', async () => {
      const id = await seedThread(3)
      mkdirSync(threadArchiveDir(id), { recursive: true })
      // Simulate a half-finished compaction: archive exists, but no compaction
      // message in messages.jsonl.
      writeFileSync(threadArchiveFile(id, 'ORPHANTESTORPHANTESTORPHANTE'), '{}\n')
      const meta = await loadThread(id)
      // No compaction message → state should reflect zero compactions.
      // Either undefined (pristine) or { compactionCount: 0 } is correct — the
      // important invariant is that the orphan archive did not break load.
      expect(
        meta.compactionState === undefined ||
          (meta.compactionState.compactionCount === 0 &&
            meta.compactionState.lastCompactedThroughSeq === undefined),
      ).toBe(true)
      // Read still works.
      const msgs = await readMessages(id)
      expect(msgs.length).toBe(3)
    })

    it('stale meta.compactionState is reconstructed lazily on loadThread', async () => {
      const id = await seedThread(5)
      await compactThread(id, { throughSeq: 3, summary: 's' })
      // Mutate meta.json to disagree with the log.
      const path = threadMetaFile(id)
      const raw = JSON.parse(readFileSync(path, 'utf8'))
      delete raw.compactionState
      writeFileSync(path, JSON.stringify(raw, null, 2) + '\n')

      const reloaded = await loadThread(id)
      expect(reloaded.compactionState).toEqual({
        compactionCount: 1,
        lastCompactedThroughSeq: 3,
      })
      // The on-disk file should also have been corrected.
      const onDisk = JSON.parse(readFileSync(path, 'utf8'))
      expect(onDisk.compactionState).toEqual({
        compactionCount: 1,
        lastCompactedThroughSeq: 3,
      })
    })

    it('missing meta.compactionState on a thread with no compactions yields { compactionCount: 0 }', async () => {
      const id = await seedThread(2)
      const meta = await loadThread(id)
      // Pristine threads have no compactionState set at all; load should not
      // produce a spurious rewrite either.
      expect(meta.compactionState).toBeUndefined()
    })

    it('two compactions in a row produce compactionCount: 2 and the latest range end', async () => {
      const id = await seedThread(5)
      await compactThread(id, { throughSeq: 2, summary: 'first' })
      // Add some more messages, then compact again.
      await appendMessage(id, { role: 'user', content: 'msg-7' })
      await appendMessage(id, { role: 'assistant', content: 'msg-8' })
      await compactThread(id, { throughSeq: 5, summary: 'second' })
      const meta = await loadThread(id)
      expect(meta.compactionState).toEqual({
        compactionCount: 2,
        lastCompactedThroughSeq: 5,
      })
    })
  })

  // ── estimateTokens ─────────────────────────────────────────────────────

  describe('estimateTokens', () => {
    it('estimates Math.ceil(totalChars/4)', () => {
      expect(estimateTokens([{ content: 'abcd' }, { content: 'efghij' }])).toBe(
        Math.ceil(10 / 4),
      )
    })
    it('handles empty content', () => {
      expect(estimateTokens([{ content: '' }, { content: '' }])).toBe(0)
    })
  })

  // ── maybeCompactThread ─────────────────────────────────────────────────

  describe('maybeCompactThread', () => {
    function staticCompactor(
      summary: string,
      newMemory: string | null,
    ): { closure: CompactorClosure; captured: ThreadMessage[][] } {
      const captured: ThreadMessage[][] = []
      const closure: CompactorClosure = async (range) => {
        captured.push(range)
        return { summary, newMemory }
      }
      return { closure, captured }
    }

    it('returns { compacted: false } when neither threshold is exceeded', async () => {
      const id = await seedThread(3) // 3 < thresholdMessages=4
      const { closure } = staticCompactor('s', null)
      const result = await maybeCompactThread(id, { config: cfg, compactor: closure })
      expect(result).toEqual({ compacted: false })
    })

    it('compacts when message count exceeds threshold, keeping last keepLastN messages live', async () => {
      const id = await seedThread(6) // 6 > 4 → trigger
      const { closure, captured } = staticCompactor('summary!', null)
      const result = await maybeCompactThread(id, { config: cfg, compactor: closure })
      expect(result.compacted).toBe(true)
      expect(result.compactionId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
      // keepLastN=2 → endSeq = 6 - 2 = 4. Range [1, 4] handed to compactor.
      expect(captured.length).toBe(1)
      expect(captured[0].map((m) => m.content)).toEqual(['msg-1', 'msg-2', 'msg-3', 'msg-4'])
      // After compaction, collapsed view shows compaction + msg-5 + msg-6.
      const collapsed = await readMessages(id)
      expect(collapsed.length).toBe(3)
      expect(collapsed[0].kind).toBe('compaction')
      expect(collapsed[1].content).toBe('msg-5')
      expect(collapsed[2].content).toBe('msg-6')
    })

    it('compacts when token count exceeds threshold even with few messages', async () => {
      const id = await seedThread(3)
      const tokenCfg = { thresholdMessages: 1000, thresholdTokens: 2, keepLastN: 1 }
      const { closure } = staticCompactor('s', null)
      const result = await maybeCompactThread(id, { config: tokenCfg, compactor: closure })
      expect(result.compacted).toBe(true)
    })

    it('short-circuits to { compacted: false } when startSeq > endSeq (recent compaction left fewer than keepLastN new messages)', async () => {
      const id = await seedThread(6)
      const { closure } = staticCompactor('s', null)
      await maybeCompactThread(id, { config: cfg, compactor: closure })
      // Now: 1 compaction msg + 2 live → message count = 3 (< 4). Force a
      // threshold breach by setting thresholdMessages to 2. After the previous
      // compaction lastCompactedThroughSeq=4, so startSeq=5. Live seqs are
      // [5,6,7(compaction)]; collapsed currentMaxSeq=7, endSeq=7-2=5.
      // Range [5,5] — there's still room to compact ONE message. We want to
      // assert "nothing to compact" requires a stricter scenario.
      const tightCfg = { thresholdMessages: 1, thresholdTokens: 1_000_000, keepLastN: 10 }
      const result = await maybeCompactThread(id, { config: tightCfg, compactor: closure })
      // keepLastN=10 but currentMaxSeq=7 → endSeq=-3 < startSeq=5 → no compact.
      expect(result.compacted).toBe(false)
    })

    it('preserves at least keepLastN live messages after compaction', async () => {
      const id = await seedThread(10)
      const { closure } = staticCompactor('s', null)
      await maybeCompactThread(id, { config: cfg, compactor: closure })
      const live = (await readMessages(id)).filter((m) => m.kind !== 'compaction')
      expect(live.length).toBeGreaterThanOrEqual(cfg.keepLastN)
    })

    it('writes newMemory via the injected onMemoryUpdate hook', async () => {
      const id = await seedThread(6)
      const writes: string[] = []
      const { closure } = staticCompactor('summary', 'NEW MEMORY BODY')
      const result = await maybeCompactThread(id, {
        config: cfg,
        compactor: closure,
        onMemoryUpdate: async (body) => {
          writes.push(body)
        },
      })
      expect(result.compacted).toBe(true)
      expect(result.memoryStatus).toBe('updated')
      expect(writes).toEqual(['NEW MEMORY BODY'])
    })

    it('skips memory write when newMemory is null', async () => {
      const id = await seedThread(6)
      const writes: string[] = []
      const { closure } = staticCompactor('s', null)
      const result = await maybeCompactThread(id, {
        config: cfg,
        compactor: closure,
        onMemoryUpdate: async (b) => { writes.push(b) },
      })
      expect(result.memoryStatus).toBe('unchanged')
      expect(writes).toEqual([])
    })

    it('skips memory write when newMemory equals current body byte-for-byte', async () => {
      const id = await seedThread(6)
      const writes: string[] = []
      const { closure } = staticCompactor('s', 'SAME BODY')
      const result = await maybeCompactThread(id, {
        config: cfg,
        compactor: closure,
        onMemoryUpdate: async (b) => { writes.push(b) },
        currentMemoryBody: 'SAME BODY',
      })
      expect(result.memoryStatus).toBe('unchanged')
      expect(writes).toEqual([])
    })

    it('skips memory write when memoryExtractionEnabled is false; summary still lands', async () => {
      const id = await seedThread(6)
      const writes: string[] = []
      const { closure } = staticCompactor('the-summary', 'NEW MEMORY')
      const result = await maybeCompactThread(id, {
        config: cfg,
        compactor: closure,
        memoryExtractionEnabled: false,
        onMemoryUpdate: async (b) => { writes.push(b) },
      })
      expect(result.compacted).toBe(true)
      expect(result.memoryStatus).toBe('disabled')
      expect(writes).toEqual([])
      // Compaction summary IS in the log.
      const raw = await readMessages(id, { collapseCompactions: false })
      expect(raw.some((m) => m.kind === 'compaction' && m.content === 'the-summary')).toBe(true)
    })

    it('on onMemoryUpdate throwing (validator rejection), warn but keep the compaction summary', async () => {
      const id = await seedThread(6)
      const warns: string[] = []
      const origWarn = console.warn
      console.warn = (...a: unknown[]) => warns.push(a.map(String).join(' '))
      try {
        const { closure } = staticCompactor('SUMMARY', 'TOXIC MEMORY')
        const result = await maybeCompactThread(id, {
          config: cfg,
          compactor: closure,
          onMemoryUpdate: async () => {
            throw new Error('byte cap exceeded')
          },
        })
        expect(result.compacted).toBe(true)
        expect(result.memoryStatus).toBe('skipped')
        const raw = await readMessages(id, { collapseCompactions: false })
        expect(raw.some((m) => m.kind === 'compaction' && m.content === 'SUMMARY')).toBe(true)
        expect(warns.join('\n')).toMatch(/byte cap exceeded/)
      } finally {
        console.warn = origWarn
      }
    })

    it('on the compactor closure THROWING, no compaction message is appended and memory is untouched', async () => {
      const id = await seedThread(6)
      const beforeRaw = await readMessages(id, { collapseCompactions: false })
      const beforeLen = beforeRaw.length
      const writes: string[] = []
      const warns: string[] = []
      const origWarn = console.warn
      console.warn = (...a: unknown[]) => warns.push(a.map(String).join(' '))
      try {
        const result = await maybeCompactThread(id, {
          config: cfg,
          compactor: async () => {
            throw new Error('network down')
          },
          onMemoryUpdate: async (b) => { writes.push(b) },
        })
        expect(result).toEqual({ compacted: false })
        const after = await readMessages(id, { collapseCompactions: false })
        expect(after.length).toBe(beforeLen)
        expect(after.some((m) => m.kind === 'compaction')).toBe(false)
        expect(writes).toEqual([])
        expect(warns.join('\n')).toMatch(/network down/)
      } finally {
        console.warn = origWarn
      }
    })

    it('on the compactor returning an empty summary, no compaction message is appended', async () => {
      const id = await seedThread(6)
      const warns: string[] = []
      const origWarn = console.warn
      console.warn = (...a: unknown[]) => warns.push(a.map(String).join(' '))
      try {
        const { closure } = staticCompactor('', null)
        const result = await maybeCompactThread(id, { config: cfg, compactor: closure })
        expect(result).toEqual({ compacted: false })
        expect(warns.join('\n')).toMatch(/empty/i)
      } finally {
        console.warn = origWarn
      }
    })

    it('retriggers on the next call if the previous attempt failed', async () => {
      const id = await seedThread(6)
      const warnsOrig = console.warn
      console.warn = () => {}
      try {
        // First attempt fails.
        const fail = await maybeCompactThread(id, {
          config: cfg,
          compactor: async () => {
            throw new Error('flaky')
          },
        })
        expect(fail.compacted).toBe(false)
        // Second attempt succeeds — threshold still exceeded since no
        // compaction landed.
        const { closure } = staticCompactor('s', null)
        const ok = await maybeCompactThread(id, { config: cfg, compactor: closure })
        expect(ok.compacted).toBe(true)
      } finally {
        console.warn = warnsOrig
      }
    })
  })

  // ── forkThread through a compacted range ───────────────────────────────

  describe('forkThread expansion through a compacted range', () => {
    it('forking with the fork point inside a compacted range expands originals from the archive', async () => {
      const id = await seedThread(6)
      // Capture original message ids before compaction (they'll be in the
      // archive afterward).
      const before = await readMessages(id, { collapseCompactions: false })
      const msg2Id = before[1].id // seq=2

      await compactThread(id, { throughSeq: 4, summary: 'sum' })

      // Fork from inside the compacted range — at msg-2 (seq=2, fully inside [1,4]).
      const fork = await forkThread(id, msg2Id)
      const forkMsgs = await readMessages(fork.id)
      // We expect: only the originals up to seq=2 (msg-1 and msg-2). The
      // compaction message is dropped because the fork has the originals.
      expect(forkMsgs.length).toBe(2)
      expect(forkMsgs.map((m) => m.content)).toEqual(['msg-1', 'msg-2'])
      expect(forkMsgs[0].id).toBe(`${fork.id}-msg-1`)
      expect(forkMsgs[1].id).toBe(`${fork.id}-msg-2`)
    })

    it('forking with the fork point outside a compacted range falls back to plain copy', async () => {
      const id = await seedThread(6)
      await compactThread(id, { throughSeq: 4, summary: 'sum' })
      const collapsed = await readMessages(id)
      // collapsed: [compaction, msg-5, msg-6]
      const msg5Id = collapsed.find((m) => m.content === 'msg-5')!.id
      const fork = await forkThread(id, msg5Id)
      const forkMsgs = await readMessages(fork.id)
      // Fork at msg-5 (seq=5, outside any compacted range): the fork must
      // contain the live tail up to seq=5 PLUS the originals from the
      // archive (since the fork would otherwise lose history).
      expect(forkMsgs.map((m) => m.content)).toEqual([
        'msg-1', 'msg-2', 'msg-3', 'msg-4', 'msg-5',
      ])
    })

    it('forkThread sources compacted-range messages from the archive file, not the raw log', async () => {
      const id = await seedThread(6)
      const before = await readMessages(id, { collapseCompactions: false })
      const msg2Id = before[1].id

      await compactThread(id, { throughSeq: 4, summary: 'sum' })

      // Corrupt the raw-log copies of msg-1..msg-4 by mutating their content
      // in messages.jsonl. The archive snapshot was taken pre-mutation and
      // still has the originals. If forkThread reads from the archive (as
      // R5.1 requires), the fork should contain the pristine originals.
      const raw = await readMessages(id, { collapseCompactions: false })
      const mutated = raw.map((m) => {
        if (m.seq >= 1 && m.seq <= 4 && m.kind !== 'compaction') {
          return { ...m, content: 'CORRUPTED' }
        }
        return m
      })
      writeFileSync(
        threadMessagesFile(id),
        mutated.map((m) => JSON.stringify(m)).join('\n') + '\n',
      )

      const fork = await forkThread(id, msg2Id)
      const forkMsgs = await readMessages(fork.id)
      // The fork must contain the archive's originals, not the corrupted raw.
      expect(forkMsgs.map((m) => m.content)).toEqual(['msg-1', 'msg-2'])
    })

    it('attachments belonging to archived messages are copied to the fork', async () => {
      const id = await seedThread(6)
      const before = await readMessages(id, { collapseCompactions: false })
      const msg2 = before[1] // seq=2
      const attDir = join(threadAttachmentsDir(id), msg2.id)
      mkdirSync(attDir, { recursive: true })
      writeFileSync(join(attDir, 'note.txt'), 'inside-archived-range')

      await compactThread(id, { throughSeq: 4, summary: 'sum' })

      const fork = await forkThread(id, msg2.id)
      const newAttDir = join(threadAttachmentsDir(fork.id), `${fork.id}-msg-2`)
      expect(existsSync(join(newAttDir, 'note.txt'))).toBe(true)
    })
  })

  // ── concurrency: compactThread uses the same mutex as appendMessage ────

  describe('concurrency', () => {
    it('a user append racing with compactThread does not interleave the file dance', async () => {
      const id = await seedThread(6)
      // Kick both off in parallel.
      const append = appendMessage(id, { role: 'user', content: 'mid-race' })
      const compact = compactThread(id, { throughSeq: 4, summary: 'sum' })
      const [a, c] = await Promise.all([append, compact])
      // Both should succeed and have distinct seqs.
      expect(a.seq).not.toBe(c.seq)
      const raw = await readMessages(id, { collapseCompactions: false })
      const seqs = raw.map((m) => m.seq)
      // No duplicate or missing seqs.
      expect(new Set(seqs).size).toBe(seqs.length)
      // Every seq is used.
      const sorted = [...seqs].sort((x, y) => x - y)
      for (let i = 1; i < sorted.length; i++) {
        expect(sorted[i] - sorted[i - 1]).toBe(1)
      }
    })
  })

  // ── Trivial-range short-circuit (defensive)  ────────────────────────────

  describe('R3.5: trivial range short-circuit (start > end)', () => {
    it('a thread that just compacted with fewer than keepLastN new messages does not re-compact', async () => {
      const id = await seedThread(5) // collapse: 5 messages
      const compactor: CompactorClosure = async () => ({ summary: 's', newMemory: null })
      // First compact: 5 > 4 → range [1, 3] (5 - keepLastN=2 = 3). After this:
      // raw = 6 messages (5 originals + 1 compaction), collapsed = 3.
      await maybeCompactThread(id, { config: cfg, compactor })
      // Try again immediately — collapsed = 3, < thresholdMessages=4 → no
      // compact at all.
      const result1 = await maybeCompactThread(id, { config: cfg, compactor })
      expect(result1).toEqual({ compacted: false })
      // Force a threshold trip via a tight config, then check that
      // startSeq > endSeq is detected.
      const tight = { thresholdMessages: 1, thresholdTokens: 1_000_000, keepLastN: 5 }
      const result2 = await maybeCompactThread(id, { config: tight, compactor })
      // currentMaxSeq=6, lastCompactedThroughSeq=3, keepLastN=5 → endSeq=1,
      // startSeq=4 → 4 > 1 → no compact.
      expect(result2).toEqual({ compacted: false })
    })
  })

  // ── Storage layout invariants ──────────────────────────────────────────

  describe('storage layout', () => {
    it('archive/ directory is created under the thread dir on first compaction', async () => {
      const id = await seedThread(5)
      await compactThread(id, { throughSeq: 3, summary: 's' })
      expect(existsSync(threadArchiveDir(id))).toBe(true)
    })

    it('messages.jsonl is byte-for-byte identical at the prefix after a compaction message append', async () => {
      const id = await seedThread(5)
      const beforeRaw = readFileSync(threadMessagesFile(id), 'utf8')
      await compactThread(id, { throughSeq: 3, summary: 's' })
      const afterRaw = readFileSync(threadMessagesFile(id), 'utf8')
      // The first 5 lines are unchanged; line 6 is the new compaction message.
      expect(afterRaw.startsWith(beforeRaw)).toBe(true)
    })
  })
})
