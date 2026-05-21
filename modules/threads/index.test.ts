import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { TEST_GUILD_DIR } = vi.hoisted(() => {
  const dir = require('node:fs').mkdtempSync(
    require('node:path').join(require('node:os').tmpdir(), 'threads-test-'),
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
  createThread,
  forkThread,
  listThreads,
  loadThread,
  readMessages,
  ThreadNotFoundError,
  threadAttachmentsDir,
  _resetMutexForTests,
} from './index'

describe('@guildbot/threads', () => {
  beforeEach(() => {
    rmSync(join(TEST_GUILD_DIR, 'threads'), { recursive: true, force: true })
    _resetMutexForTests()
  })

  afterEach(() => {
    rmSync(join(TEST_GUILD_DIR, 'threads'), { recursive: true, force: true })
  })

  describe('R1: storage', () => {
    it('createThread creates a ULID-named directory with meta.json + messages.jsonl', async () => {
      const meta = await createThread({ guildId: 'discord:g1' })
      expect(meta.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/) // ULID Crockford-base32
      expect(existsSync(join(TEST_GUILD_DIR, 'threads', meta.id, 'meta.json'))).toBe(true)
      expect(existsSync(join(TEST_GUILD_DIR, 'threads', meta.id, 'messages.jsonl'))).toBe(true)
    })

    it('listThreads yields chronological order by ULID', async () => {
      const a = await createThread({ guildId: 'g' })
      await new Promise((r) => setTimeout(r, 2))
      const b = await createThread({ guildId: 'g' })
      const list = await listThreads()
      expect(list.map((m) => m.id)).toEqual([a.id, b.id])
    })

    it('guildId is set at creation and persisted', async () => {
      const meta = await createThread({ guildId: 'discord:abc' })
      const reloaded = await loadThread(meta.id)
      expect(reloaded.guildId).toBe('discord:abc')
    })

    it('appendMessage assigns monotonically increasing seq and stable ids', async () => {
      const meta = await createThread({ guildId: 'g' })
      const a = await appendMessage(meta.id, { role: 'user', content: 'hi' })
      const b = await appendMessage(meta.id, { role: 'assistant', content: 'hey' })
      const c = await appendMessage(meta.id, { role: 'user', content: 'q?' })
      expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3])
      expect(a.id).toBe(`${meta.id}-msg-1`)
      expect(c.id).toBe(`${meta.id}-msg-3`)
    })

    it('loadThread throws ThreadNotFoundError on a missing thread', async () => {
      await expect(loadThread('does-not-exist')).rejects.toBeInstanceOf(ThreadNotFoundError)
    })

    it('forkThread throws ThreadNotFoundError on a missing source', async () => {
      await expect(forkThread('missing-src', 'whatever')).rejects.toBeInstanceOf(
        ThreadNotFoundError,
      )
    })

    it('concurrent appends produce distinct sequential seq values with no loss', async () => {
      const meta = await createThread({ guildId: 'g' })
      const N = 20
      const promises = Array.from({ length: N }, (_, i) =>
        appendMessage(meta.id, { role: 'user', content: `msg-${i}` }),
      )
      const results = await Promise.all(promises)
      const seqs = results.map((r) => r.seq).sort((a, b) => a - b)
      expect(seqs).toEqual(Array.from({ length: N }, (_, i) => i + 1))
      const onDisk = await readMessages(meta.id)
      expect(onDisk.map((m) => m.seq)).toEqual(seqs)
    })

    it('title is derived from the first user message (≤80 chars)', async () => {
      const meta = await createThread({ guildId: 'g' })
      await appendMessage(meta.id, {
        role: 'user',
        content: 'A really long first question that goes on and on '.repeat(5),
      })
      const reloaded = await loadThread(meta.id)
      expect(reloaded.title?.length).toBeLessThanOrEqual(80)
      expect(reloaded.title?.startsWith('A really long first question')).toBe(true)
    })

    it('title falls back to "Thread <date>" when no user message available', async () => {
      const meta = await createThread({ guildId: 'g' })
      expect(meta.title).toMatch(/^Thread \d{4}-\d{2}-\d{2}$/)
    })

    it('existing JSONL lines are preserved byte-for-byte across appends', async () => {
      const meta = await createThread({ guildId: 'g' })
      await appendMessage(meta.id, { role: 'user', content: 'one' })
      const firstLine = require('node:fs')
        .readFileSync(join(TEST_GUILD_DIR, 'threads', meta.id, 'messages.jsonl'), 'utf8')
        .split('\n')[0]
      await appendMessage(meta.id, { role: 'assistant', content: 'two' })
      const lines = require('node:fs')
        .readFileSync(join(TEST_GUILD_DIR, 'threads', meta.id, 'messages.jsonl'), 'utf8')
        .split('\n')
      expect(lines[0]).toBe(firstLine)
    })
  })

  describe('R4: forking', () => {
    it('forkThread creates a new thread parented at the fork point with messages up to cutoff', async () => {
      const src = await createThread({ guildId: 'g' })
      const a = await appendMessage(src.id, { role: 'user', content: 'q1' })
      const b = await appendMessage(src.id, { role: 'assistant', content: 'a1' })
      await appendMessage(src.id, { role: 'user', content: 'q2' })

      const fork = await forkThread(src.id, b.id)
      expect(fork.parent?.threadId).toBe(src.id)
      expect(fork.parent?.forkedAfterMessageId).toBe(b.id)

      const forkMsgs = await readMessages(fork.id)
      expect(forkMsgs.length).toBe(2)
      expect(forkMsgs.map((m) => m.content)).toEqual(['q1', 'a1'])
      expect(forkMsgs[0].id).toBe(`${fork.id}-msg-1`)
    })

    it('forking copies referenced attachments to the new thread', async () => {
      const src = await createThread({ guildId: 'g' })
      const a = await appendMessage(src.id, { role: 'user', content: 'with file' })
      const fs = require('node:fs') as typeof import('node:fs')
      const attDir = join(threadAttachmentsDir(src.id), a.id)
      fs.mkdirSync(attDir, { recursive: true })
      writeFileSync(join(attDir, 'note.txt'), 'hello attachment')

      const fork = await forkThread(src.id, a.id)
      const newAttDir = join(threadAttachmentsDir(fork.id), `${fork.id}-msg-1`)
      expect(existsSync(join(newAttDir, 'note.txt'))).toBe(true)
    })

    it('forking does NOT copy Discord index entries', async () => {
      const src = await createThread({ guildId: 'g' })
      const a = await appendMessage(src.id, { role: 'user', content: 'q' })
      const fs = require('node:fs') as typeof import('node:fs')
      const indexDir = join(TEST_GUILD_DIR, 'threads', 'index', 'discord', 'thread')
      fs.mkdirSync(indexDir, { recursive: true })
      fs.writeFileSync(join(indexDir, 'orig-channel.json'), JSON.stringify({ threadId: src.id }))

      const fork = await forkThread(src.id, a.id)
      // The new fork's id is not referenced by any index entry.
      const files = fs.readdirSync(indexDir)
      expect(files).toEqual(['orig-channel.json'])
      expect(fs.readFileSync(join(indexDir, 'orig-channel.json'), 'utf8')).toContain(src.id)
      expect(fs.readFileSync(join(indexDir, 'orig-channel.json'), 'utf8')).not.toContain(fork.id)
    })

    it('forkThread throws if afterMessageId is not in the source thread', async () => {
      const src = await createThread({ guildId: 'g' })
      await appendMessage(src.id, { role: 'user', content: 'q' })
      await expect(forkThread(src.id, 'bogus-msg-id')).rejects.toThrow(/Fork point not found/)
    })
  })

  describe('R3: agent-loop friendly history', () => {
    it('readMessages returns full ThreadMessage records including tool fields', async () => {
      const meta = await createThread({ guildId: 'g' })
      await appendMessage(meta.id, { role: 'user', content: 'q' })
      await appendMessage(meta.id, {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc1', name: 'search', arguments: { q: 'x' } }],
      })
      await appendMessage(meta.id, {
        role: 'tool',
        content: '{"ok":true}',
        toolName: 'search',
        toolCallId: 'tc1',
      })
      const msgs = await readMessages(meta.id)
      expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'tool'])
      expect(msgs[1].toolCalls?.[0].name).toBe('search')
      expect(msgs[2].toolCallId).toBe('tc1')
    })
  })

  describe('platform independence', () => {
    it('does not import discord.js', async () => {
      const fs = require('node:fs') as typeof import('node:fs')
      const path = require('node:path') as typeof import('node:path')
      const files = [
        'createThread.ts',
        'appendMessage.ts',
        'forkThread.ts',
        'readMessages.ts',
        'index.ts',
        'loadThread.ts',
        'listThreads.ts',
        'mutex.ts',
        'paths.ts',
        'types.ts',
        // Plan 008 additions:
        'compactThread.ts',
        'estimateTokens.ts',
        'maybeCompactThread.ts',
      ]
      // Look for actual import statements only — comments referencing the
      // forbidden modules are fine.
      const importPattern = /(?:from\s+['"]|require\(\s*['"])([^'"\)]+)['"]/g
      for (const f of files) {
        const content = fs.readFileSync(path.join(__dirname, f), 'utf8')
        const imports = [...content.matchAll(importPattern)].map((m) => m[1])
        expect(imports).not.toContain('discord.js')
        expect(imports).not.toContain('@guildbot/discord-index')
      }
    })
  })
})
