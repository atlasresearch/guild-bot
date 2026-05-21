// R6.12 — Tests MUST cover the CLI cmdThreadChat REPL path through
// maybeCompactThread, not just the Discord dispatcher.
//
// We exercise the per-turn handler `runCliChatTurn` with a real threads
// module + real updateMemory, mocking only @guildbot/llm (structured) and the
// agent loop. After the synthesized turn, we expect a compaction log line and
// a compaction message in the thread's messages.jsonl.

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { TEST_GUILD_DIR } = vi.hoisted(() => {
  const fs = require('node:fs') as typeof import('node:fs')
  const path = require('node:path') as typeof import('node:path')
  const os = require('node:os') as typeof import('node:os')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-compaction-'))
  process.env.GUILDBOT_GUILD_DIR = dir
  return { TEST_GUILD_DIR: dir as string }
})

const VALID_CONFIG = {
  version: 1,
  guild: { id: 'discord:cli-compaction', name: 'test' },
  discord: { token: { $secret: 'discord.token' } },
  llm: {
    provider: 'ollama',
    baseUrl: 'http://localhost:11434',
    models: { default: 'qwen3.6', embed: 'nomic-embed-text' },
    embed: {},
  },
  recording: {},
  threads: { compaction: { thresholdMessages: 3, thresholdTokens: 1_000_000, keepLastN: 1 } },
  memory: { maxBytes: 32000, extractionEnabled: true, operatorRoleIds: [] },
  tools: { disabled: [], editAllowlist: ['prompt.md', 'memory.md'] },
}

vi.mock('@guildbot/guild-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@guildbot/guild-config')>()
  return {
    ...actual,
    paths: (guildDir?: string) => actual.paths(guildDir ?? TEST_GUILD_DIR),
  }
})

const { structuredMock } = vi.hoisted(() => ({ structuredMock: vi.fn() }))
vi.mock('@guildbot/llm', () => ({ structured: structuredMock }))

const { agentLoopMock } = vi.hoisted(() => ({ agentLoopMock: vi.fn() }))
vi.mock('./agent/loop', () => ({ agentLoop: agentLoopMock }))

import { runCliChatTurn } from './cli-thread'
import { appendMessage, createThread, readMessages, _resetMutexForTests } from '@guildbot/threads'
import { loadMemory } from '@guildbot/guild-config'

function seedGuildFiles() {
  mkdirSync(TEST_GUILD_DIR, { recursive: true })
  mkdirSync(join(TEST_GUILD_DIR, 'history', 'prompt'), { recursive: true })
  mkdirSync(join(TEST_GUILD_DIR, 'history', 'memory'), { recursive: true })
  mkdirSync(join(TEST_GUILD_DIR, 'snapshots'), { recursive: true })
  writeFileSync(
    join(TEST_GUILD_DIR, 'prompt.md'),
    `---\nversion: 1\nupdatedAt: 2026-05-20T00:00:00.000Z\n---\n\nYou are this guild's assistant.\n`,
    'utf8',
  )
  writeFileSync(
    join(TEST_GUILD_DIR, 'memory.md'),
    `---\nversion: 1\nupdatedAt: 2026-05-20T00:00:00.000Z\n---\n\nStarter notes.\n`,
    'utf8',
  )
  writeFileSync(join(TEST_GUILD_DIR, 'config.json'), JSON.stringify(VALID_CONFIG), 'utf8')
  const secretsPath = join(TEST_GUILD_DIR, 'secrets.json')
  writeFileSync(secretsPath, JSON.stringify({ 'discord.token': 'fake' }), 'utf8')
  chmodSync(secretsPath, 0o600)
}

describe('cli-thread: runCliChatTurn triggers compaction', () => {
  beforeEach(() => {
    rmSync(TEST_GUILD_DIR, { recursive: true, force: true })
    seedGuildFiles()
    _resetMutexForTests()
    structuredMock.mockReset()
    agentLoopMock.mockReset()
  })
  afterEach(() => {
    rmSync(TEST_GUILD_DIR, { recursive: true, force: true })
  })

  it('after the agent loop returns, the CLI calls runCompactionIfNeeded — compaction lands and the log line is returned', async () => {
    // Seed the thread with enough messages to trip the threshold once the
    // user's new turn is appended.
    const meta = await createThread({ guildId: 'discord:cli-compaction' })
    await appendMessage(meta.id, { role: 'user', content: 'msg-1' })
    await appendMessage(meta.id, { role: 'assistant', content: 'msg-2' })

    // Mock the agent loop to simulate the final assistant message being
    // appended via onMessage, then return the answer.
    agentLoopMock.mockImplementationOnce(async (opts: any) => {
      await opts.onMessage({ role: 'assistant', content: 'final answer' })
      return 'final answer'
    })

    // Mock structured() to return a summary + memory rewrite.
    structuredMock.mockResolvedValueOnce({
      success: true,
      data: { summary: 'cli-turn summary', newMemory: 'CLI MEMORY\n' },
    })

    const { answer, compactionLine } = await runCliChatTurn(meta.id, 'hello there')

    expect(answer).toBe('final answer')
    expect(compactionLine).toMatch(/^\[compaction\] thread .* compacted/)
    expect(compactionLine).toContain('memory: updated')

    // Compaction message is in the raw log.
    const raw = await readMessages(meta.id, { collapseCompactions: false })
    expect(raw.some((m) => m.kind === 'compaction' && m.content === 'cli-turn summary')).toBe(true)

    // Memory was rewritten through the validator floor.
    const mem = await loadMemory()
    expect(mem.content).toBe('CLI MEMORY\n')
  })

  it('below threshold the CLI does NOT call structured() and returns an empty compactionLine', async () => {
    const meta = await createThread({ guildId: 'discord:cli-compaction' })
    agentLoopMock.mockImplementationOnce(async (opts: any) => {
      await opts.onMessage({ role: 'assistant', content: 'tiny reply' })
      return 'tiny reply'
    })

    const { answer, compactionLine } = await runCliChatTurn(meta.id, 'hi')

    expect(answer).toBe('tiny reply')
    expect(compactionLine).toBe('')
    expect(structuredMock).not.toHaveBeenCalled()
  })
})
