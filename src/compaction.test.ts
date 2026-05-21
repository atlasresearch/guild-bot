// Tests for the dispatcher-level compaction wiring (plan 008).
//
// These tests use real @guildbot/threads and real @guildbot/guild-config
// (including updateMemory's validator floor) — only @guildbot/llm's
// structured() is mocked, per plan 008 R6.13.
//
// What's covered here:
//   - The extractor system message contains NO ontology, NO scope guidance,
//     NO redaction guidance, NO heading enforcement (R6.11).
//   - Successful structured() result lands as the compaction summary AND
//     writes newMemory through updateMemory verbatim, bumping the version
//     exactly once (R6.7).
//   - extractionEnabled=false skips the memory write but lets the summary
//     land (R6.8).
//   - newMemory === null OR == current body skips the memory write (R6.9).
//   - All three validator rejection cases (empty, byte cap, secret) leave
//     memory unchanged AND keep the summary (R6.10).
//   - structured() throwing OR returning a malformed object aborts the whole
//     compaction without touching memory or messages (R6.14).

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

const { TEST_GUILD_DIR } = vi.hoisted(() => {
  const fs = require('node:fs') as typeof import('node:fs')
  const path = require('node:path') as typeof import('node:path')
  const os = require('node:os') as typeof import('node:os')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compaction-src-'))
  // Set so resolveGuildDir() picks up the test dir for loadConfig() calls.
  process.env.GUILDBOT_GUILD_DIR = dir
  return { TEST_GUILD_DIR: dir as string }
})

const VALID_CONFIG = {
  version: 1,
  guild: { id: 'discord:test-compaction', name: 'test' },
  discord: { token: { $secret: 'discord.token' } },
  llm: {
    provider: 'ollama',
    baseUrl: 'http://localhost:11434',
    models: { default: 'qwen3.6', embed: 'nomic-embed-text' },
    embed: {},
  },
  recording: {},
  threads: { compaction: { thresholdMessages: 3, thresholdTokens: 1_000_000, keepLastN: 2 } },
  memory: { maxBytes: 32000, extractionEnabled: true, operatorRoleIds: [] },
  tools: { disabled: [], editAllowlist: ['prompt.md', 'memory.md'] },
}

const SEED_MEMORY = `---
version: 1
updatedAt: 2026-05-20T00:00:00.000Z
---

Free-form starter notes.
`

const SEED_PROMPT = `---
version: 1
updatedAt: 2026-05-20T00:00:00.000Z
---

You are this guild's assistant.
`

vi.mock('@guildbot/guild-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@guildbot/guild-config')>()
  return {
    ...actual,
    paths: (guildDir?: string) => actual.paths(guildDir ?? TEST_GUILD_DIR),
  }
})

// Hoist a single structured() mock that tests configure per-case.
const { structuredMock } = vi.hoisted(() => ({
  structuredMock: vi.fn(),
}))
vi.mock('@guildbot/llm', () => ({
  structured: structuredMock,
}))

import { runCompactionIfNeeded, buildCompactor, COMPACTION_FRAMING, serializeRange } from './compaction'
import { appendMessage, createThread, readMessages, _resetMutexForTests } from '@guildbot/threads'
import { loadMemory } from '@guildbot/guild-config'

function seedGuildFiles() {
  mkdirSync(TEST_GUILD_DIR, { recursive: true })
  mkdirSync(join(TEST_GUILD_DIR, 'history', 'prompt'), { recursive: true })
  mkdirSync(join(TEST_GUILD_DIR, 'history', 'memory'), { recursive: true })
  mkdirSync(join(TEST_GUILD_DIR, 'snapshots'), { recursive: true })
  writeFileSync(join(TEST_GUILD_DIR, 'prompt.md'), SEED_PROMPT, 'utf8')
  writeFileSync(join(TEST_GUILD_DIR, 'memory.md'), SEED_MEMORY, 'utf8')
  writeFileSync(join(TEST_GUILD_DIR, 'config.json'), JSON.stringify(VALID_CONFIG), 'utf8')
  const secretsPath = join(TEST_GUILD_DIR, 'secrets.json')
  writeFileSync(secretsPath, JSON.stringify({ 'discord.token': 'fake' }), 'utf8')
  chmodSync(secretsPath, 0o600)
}

async function seedThread(n: number) {
  const meta = await createThread({ guildId: 'discord:test-compaction' })
  for (let i = 1; i <= n; i++) {
    await appendMessage(meta.id, {
      role: i % 2 === 1 ? 'user' : 'assistant',
      content: `msg-${i}`,
    })
  }
  return meta.id
}

describe('src/compaction — dispatcher wiring', () => {
  beforeEach(() => {
    rmSync(TEST_GUILD_DIR, { recursive: true, force: true })
    seedGuildFiles()
    _resetMutexForTests()
    structuredMock.mockReset()
  })
  afterEach(() => {
    rmSync(TEST_GUILD_DIR, { recursive: true, force: true })
  })

  // ── Prompt shape (no ontology, no scope guidance) ─────────────────────

  it('the structured() call passes only renderGuildSystemMessage + a short framing line + serialised range — no ontology / no scope / no redaction guidance', async () => {
    structuredMock.mockResolvedValueOnce({ success: true, data: { summary: 's', newMemory: null } })
    const id = await seedThread(5)
    await runCompactionIfNeeded(id)

    expect(structuredMock).toHaveBeenCalledTimes(1)
    const callArg = structuredMock.mock.calls[0][0] as {
      messages: { role: string; content: string }[]
      schema: z.ZodTypeAny
    }
    const sysMessages = callArg.messages.filter((m) => m.role === 'system')
    expect(sysMessages).toHaveLength(2)
    // First system message is the rendered guild prompt+memory.
    expect(sysMessages[0].content).toContain('You are this guild')
    expect(sysMessages[0].content).toContain('Free-form starter notes')
    // The renderer no longer injects the `## Long-term memory` delimiter.
    expect(sysMessages[0].content).not.toContain('## Long-term memory')
    // Second system message is the framing line — mechanics only.
    expect(sysMessages[1].content).toBe(COMPACTION_FRAMING)
    // Forbidden vocabulary in the prompt context (case-insensitive).
    const combined = callArg.messages.map((m) => m.content).join('\n').toLowerCase()
    for (const banned of [
      'people',
      'projects',
      'decisions',
      'norms',
      'redact',
      'pii',
      'scope',
      'category',
      'merge',
      'heading',
    ]) {
      expect(combined).not.toMatch(new RegExp(`\\b${banned}\\b`))
    }
    // Schema is the {summary, newMemory} pair — no enum, no array of categories.
    const json = z.toJSONSchema(callArg.schema, { target: 'draft-7' }) as any
    expect(Object.keys(json.properties || {})).toEqual(['summary', 'newMemory'])
    // newMemory must accept both string and null. Different Zod versions
    // emit either `{ type: ["string", "null"] }` or `{ anyOf: [...] }`; the
    // contract is that the Zod schema parses both, not its JSON encoding.
    expect(callArg.schema.safeParse({ summary: 's', newMemory: 'x' }).success).toBe(true)
    expect(callArg.schema.safeParse({ summary: 's', newMemory: null }).success).toBe(true)
    expect(callArg.schema.safeParse({ summary: 's' }).success).toBe(false)
  })

  it('serializeRange formats messages as one {role, content} JSON line each', () => {
    const out = serializeRange([
      { id: 'a', seq: 1, role: 'user', content: 'one', ts: '' } as any,
      { id: 'b', seq: 2, role: 'assistant', content: 'two', ts: '' } as any,
    ])
    const lines = out.split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0])).toEqual({ role: 'user', content: 'one' })
    expect(JSON.parse(lines[1])).toEqual({ role: 'assistant', content: 'two' })
  })

  // ── Happy path ─────────────────────────────────────────────────────────

  it('a successful compaction lands the summary in messages.jsonl AND writes newMemory through updateMemory verbatim', async () => {
    structuredMock.mockResolvedValueOnce({
      success: true,
      data: { summary: 'thread summarised', newMemory: 'NEW MEMORY BODY\n' },
    })
    const id = await seedThread(5)
    const before = await loadMemory()

    const result = await runCompactionIfNeeded(id)
    expect(result.compacted).toBe(true)
    expect(result.memoryStatus).toBe('updated')

    // Summary lands.
    const raw = await readMessages(id, { collapseCompactions: false })
    const compMsg = raw.find((m) => m.kind === 'compaction')
    expect(compMsg?.content).toBe('thread summarised')

    // Memory body equals newMemory verbatim.
    const after = await loadMemory()
    expect(after.content).toBe('NEW MEMORY BODY\n')
    expect(after.version).toBe(before.version + 1)
    // Exactly one history entry was written.
    const histEntries = readdirSync(join(TEST_GUILD_DIR, 'history', 'memory'))
    expect(histEntries).toHaveLength(1)
    expect(histEntries[0]).toContain('compaction')
  })

  // ── extractionEnabled = false ──────────────────────────────────────────

  it('with extractionEnabled = false the memory write is skipped; the compaction summary STILL lands', async () => {
    const cfg = { ...VALID_CONFIG, memory: { ...VALID_CONFIG.memory, extractionEnabled: false } }
    writeFileSync(join(TEST_GUILD_DIR, 'config.json'), JSON.stringify(cfg), 'utf8')

    structuredMock.mockResolvedValueOnce({
      success: true,
      data: { summary: 'summary X', newMemory: 'this should not land' },
    })
    const id = await seedThread(5)
    const beforeMem = await loadMemory()

    const result = await runCompactionIfNeeded(id)
    expect(result.compacted).toBe(true)
    expect(result.memoryStatus).toBe('disabled')

    const afterMem = await loadMemory()
    expect(afterMem.version).toBe(beforeMem.version) // no bump
    expect(afterMem.content).toBe(beforeMem.content)
    expect(readdirSync(join(TEST_GUILD_DIR, 'history', 'memory'))).toHaveLength(0)

    const raw = await readMessages(id, { collapseCompactions: false })
    expect(raw.some((m) => m.kind === 'compaction' && m.content === 'summary X')).toBe(true)
  })

  // ── newMemory: null / equal-to-current ─────────────────────────────────

  it('with newMemory: null the memory write is skipped', async () => {
    structuredMock.mockResolvedValueOnce({
      success: true,
      data: { summary: 's', newMemory: null },
    })
    const id = await seedThread(5)
    const beforeMem = await loadMemory()
    const result = await runCompactionIfNeeded(id)
    expect(result.memoryStatus).toBe('unchanged')
    expect((await loadMemory()).version).toBe(beforeMem.version)
    expect(readdirSync(join(TEST_GUILD_DIR, 'history', 'memory'))).toHaveLength(0)
  })

  it('with newMemory byte-for-byte equal to the current memory body the memory write is skipped', async () => {
    const before = await loadMemory()
    structuredMock.mockResolvedValueOnce({
      success: true,
      data: { summary: 's', newMemory: before.content },
    })
    const id = await seedThread(5)
    const result = await runCompactionIfNeeded(id)
    expect(result.memoryStatus).toBe('unchanged')
    expect((await loadMemory()).version).toBe(before.version)
    expect(readdirSync(join(TEST_GUILD_DIR, 'history', 'memory'))).toHaveLength(0)
  })

  // ── Validator rejection paths ──────────────────────────────────────────

  describe('validator rejection — summary lands, memory unchanged', () => {
    it('empty / whitespace-only newMemory is rejected; summary lands', async () => {
      const origWarn = console.warn
      const warns: string[] = []
      console.warn = (...a: unknown[]) => warns.push(a.map(String).join(' '))
      try {
        structuredMock.mockResolvedValueOnce({
          success: true,
          data: { summary: 'lands', newMemory: '   \n  ' },
        })
        const id = await seedThread(5)
        const beforeMem = await loadMemory()
        const result = await runCompactionIfNeeded(id)
        expect(result.compacted).toBe(true)
        expect(result.memoryStatus).toBe('skipped')
        expect((await loadMemory()).version).toBe(beforeMem.version)
        const raw = await readMessages(id, { collapseCompactions: false })
        expect(raw.some((m) => m.kind === 'compaction' && m.content === 'lands')).toBe(true)
        expect(readdirSync(join(TEST_GUILD_DIR, 'history', 'memory'))).toHaveLength(0)
        expect(warns.join('\n')).toMatch(/empty/i)
      } finally {
        console.warn = origWarn
      }
    })

    it('newMemory exceeding config.memory.maxBytes is rejected; summary lands', async () => {
      const origWarn = console.warn
      console.warn = () => {}
      try {
        const oversized = 'x'.repeat(40_000) // > 32_000
        structuredMock.mockResolvedValueOnce({
          success: true,
          data: { summary: 'lands-too', newMemory: oversized },
        })
        const id = await seedThread(5)
        const beforeMem = await loadMemory()
        const result = await runCompactionIfNeeded(id)
        expect(result.compacted).toBe(true)
        expect(result.memoryStatus).toBe('skipped')
        expect((await loadMemory()).version).toBe(beforeMem.version)
        const raw = await readMessages(id, { collapseCompactions: false })
        expect(raw.some((m) => m.kind === 'compaction' && m.content === 'lands-too')).toBe(true)
      } finally {
        console.warn = origWarn
      }
    })

    it('newMemory containing a Discord-token-shaped secret is rejected; summary lands', async () => {
      const origWarn = console.warn
      console.warn = () => {}
      try {
        // Assembled at runtime — keeps GitHub's secret scanner happy.
        const tokenLike = [
          'FAKE-TOKEN-FOR-TEST-ONLY-XXXX',
          'NOTREAL',
          'THIS-IS-NOT-A-REAL-DISCORD-BOT-TOKEN',
        ].join('.')
        structuredMock.mockResolvedValueOnce({
          success: true,
          data: { summary: 'lands-three', newMemory: `Notes\nleaked=${tokenLike}\n` },
        })
        const id = await seedThread(5)
        const beforeMem = await loadMemory()
        const result = await runCompactionIfNeeded(id)
        expect(result.compacted).toBe(true)
        expect(result.memoryStatus).toBe('skipped')
        expect((await loadMemory()).version).toBe(beforeMem.version)
        const raw = await readMessages(id, { collapseCompactions: false })
        expect(raw.some((m) => m.kind === 'compaction' && m.content === 'lands-three')).toBe(true)
      } finally {
        console.warn = origWarn
      }
    })
  })

  // ── structured() failure paths ─────────────────────────────────────────

  describe('structured() failure', () => {
    it('a network/LLM failure (structured returns success:false) aborts compaction — no message appended, no memory write', async () => {
      const origWarn = console.warn
      const warns: string[] = []
      console.warn = (...a: unknown[]) => warns.push(a.map(String).join(' '))
      try {
        structuredMock.mockResolvedValueOnce({ success: false, error: 'fetch failed' })
        const id = await seedThread(5)
        const beforeMem = await loadMemory()
        const beforeRaw = await readMessages(id, { collapseCompactions: false })

        const result = await runCompactionIfNeeded(id)
        expect(result).toEqual({ compacted: false })
        // No compaction message landed.
        const afterRaw = await readMessages(id, { collapseCompactions: false })
        expect(afterRaw.length).toBe(beforeRaw.length)
        expect(afterRaw.some((m) => m.kind === 'compaction')).toBe(false)
        // Memory unchanged.
        expect((await loadMemory()).version).toBe(beforeMem.version)
        expect(readdirSync(join(TEST_GUILD_DIR, 'history', 'memory'))).toHaveLength(0)
        expect(warns.join('\n')).toMatch(/fetch failed/)
      } finally {
        console.warn = origWarn
      }
    })

    it('the compactor closure THROWING is also handled', async () => {
      const origWarn = console.warn
      console.warn = () => {}
      try {
        structuredMock.mockRejectedValueOnce(new Error('boom'))
        const id = await seedThread(5)
        const beforeRaw = await readMessages(id, { collapseCompactions: false })

        const result = await runCompactionIfNeeded(id)
        expect(result).toEqual({ compacted: false })
        const afterRaw = await readMessages(id, { collapseCompactions: false })
        expect(afterRaw.length).toBe(beforeRaw.length)
      } finally {
        console.warn = origWarn
      }
    })
  })

  // ── No compaction below threshold ──────────────────────────────────────

  it('does not call structured() at all when below threshold', async () => {
    const id = await seedThread(2) // 2 < thresholdMessages=3
    const result = await runCompactionIfNeeded(id)
    expect(result).toEqual({ compacted: false })
    expect(structuredMock).not.toHaveBeenCalled()
  })

  // ── buildCompactor exposes a callable closure ─────────────────────────

  it('buildCompactor exposes a closure that calls structured() and returns its data', async () => {
    structuredMock.mockResolvedValueOnce({
      success: true,
      data: { summary: 's', newMemory: 'm' },
    })
    const closure = buildCompactor()
    const result = await closure([
      { id: 'a', seq: 1, role: 'user', content: 'one', ts: '' } as any,
    ])
    expect(result).toEqual({ summary: 's', newMemory: 'm' })
  })

  it('buildCompactor throws when structured() reports failure', async () => {
    structuredMock.mockResolvedValueOnce({ success: false, error: 'nope' })
    const closure = buildCompactor()
    await expect(closure([])).rejects.toThrow(/nope/)
  })
})
