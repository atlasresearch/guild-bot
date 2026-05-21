// CLI thread sub-command tests. Plan 005 R5.

import fsp from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { TEST_GUILD_DIR } = vi.hoisted(() => {
  const fs = require('node:fs') as typeof import('node:fs')
  const path = require('node:path') as typeof import('node:path')
  const os = require('node:os') as typeof import('node:os')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-thread-'))
  return { TEST_GUILD_DIR: dir as string }
})

vi.mock('@guildbot/guild-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@guildbot/guild-config')>()
  return {
    ...actual,
    paths: (guildDir?: string) => actual.paths(guildDir ?? TEST_GUILD_DIR),
    loadConfig: () =>
      ({
        guild: { id: 'discord:cli-guild', name: 'cli' },
        llm: { models: { default: 'qwen' } },
      }) as any,
  }
})

// We don't drive 'chat' end-to-end in tests; ensure agentLoop is mockable when needed.
vi.mock('./agent/loop', () => ({ agentLoop: vi.fn() }))

import { cmdThread } from './cli-thread'
import { listThreads, loadThread, appendMessage } from '@guildbot/threads'

const captureStdout = () => {
  const logs: string[] = []
  const orig = console.log
  console.log = (...args: any[]) => {
    logs.push(args.map(String).join(' '))
  }
  return {
    logs,
    restore: () => {
      console.log = orig
    },
  }
}

describe('guildbot thread CLI', () => {
  beforeEach(async () => {
    await fsp.rm(`${TEST_GUILD_DIR}/threads`, { recursive: true, force: true })
  })
  afterEach(async () => {
    await fsp.rm(`${TEST_GUILD_DIR}/threads`, { recursive: true, force: true })
  })

  it('thread new creates a thread and prints its id', async () => {
    const cap = captureStdout()
    try {
      await cmdThread(['new', '--guild', 'discord:test', '--title', 'Hello'])
    } finally {
      cap.restore()
    }
    expect(cap.logs).toHaveLength(1)
    const id = cap.logs[0]
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    const meta = await loadThread(id)
    expect(meta.guildId).toBe('discord:test')
    expect(meta.title).toBe('Hello')
  })

  it('thread list reports each existing thread', async () => {
    const cap = captureStdout()
    try {
      await cmdThread(['new', '--guild', 'g1'])
      await cmdThread(['new', '--guild', 'g1'])
    } finally {
      cap.restore()
    }
    const cap2 = captureStdout()
    try {
      await cmdThread(['list'])
    } finally {
      cap2.restore()
    }
    expect(cap2.logs.length).toBe(2)
    for (const line of cap2.logs) {
      expect(line).toContain('g1')
    }
  })

  it('thread show prints meta + messages', async () => {
    const cap = captureStdout()
    try {
      await cmdThread(['new', '--guild', 'g1', '--title', 'show-me'])
    } finally {
      cap.restore()
    }
    const [t] = await listThreads()
    await appendMessage(t.id, { role: 'user', content: 'first user turn' })
    await appendMessage(t.id, { role: 'assistant', content: 'first reply' })

    const cap2 = captureStdout()
    try {
      await cmdThread(['show', t.id])
    } finally {
      cap2.restore()
    }
    const joined = cap2.logs.join('\n')
    expect(joined).toContain(t.id)
    expect(joined).toContain('first user turn')
    expect(joined).toContain('first reply')
    // The thread is created with a guild-prompt system message + the two
    // turns we appended above = 3 messages total.
    expect(joined).toContain('messages:  3')
  })

  it('thread fork creates a new thread parented at --after <messageId>', async () => {
    const cap = captureStdout()
    try {
      await cmdThread(['new', '--guild', 'g1'])
    } finally {
      cap.restore()
    }
    const [src] = await listThreads()
    const m1 = await appendMessage(src.id, { role: 'user', content: 'q' })

    const cap2 = captureStdout()
    try {
      await cmdThread(['fork', src.id, '--after', m1.id])
    } finally {
      cap2.restore()
    }
    expect(cap2.logs).toHaveLength(1)
    const forkId = cap2.logs[0]
    const fork = await loadThread(forkId)
    expect(fork.parent?.threadId).toBe(src.id)
    expect(fork.parent?.forkedAfterMessageId).toBe(m1.id)
  })

  it('thread show with a missing id exits with an error', async () => {
    const errs: string[] = []
    const origErr = console.error
    const origExit = process.exit
    let exitCode: number | undefined
    console.error = (...a) => errs.push(a.map(String).join(' '))
    process.exit = ((code?: number) => {
      exitCode = code
      throw new Error('__exit__')
    }) as any
    try {
      await expect(cmdThread(['show', 'BOGUS'])).rejects.toThrow('__exit__')
      expect(exitCode).toBe(1)
      expect(errs.join('\n')).toContain('Thread not found: BOGUS')
    } finally {
      console.error = origErr
      process.exit = origExit
    }
  })
})
