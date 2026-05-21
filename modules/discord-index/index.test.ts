import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { TEST_GUILD_DIR } = vi.hoisted(() => {
  const dir = require('node:fs').mkdtempSync(
    require('node:path').join(require('node:os').tmpdir(), 'discord-index-test-'),
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

import { bindDiscord, resolveDiscord, unbindDiscord } from './index'

describe('@guildbot/discord-index', () => {
  beforeEach(() => {
    rmSync(join(TEST_GUILD_DIR, 'threads'), { recursive: true, force: true })
  })

  afterEach(() => {
    rmSync(join(TEST_GUILD_DIR, 'threads'), { recursive: true, force: true })
  })

  it('bind + resolve round-trip for kind=thread', async () => {
    await bindDiscord({ kind: 'thread', key: 'discord-channel-1', threadId: 'THREAD_A' })
    const id = await resolveDiscord({ kind: 'thread', key: 'discord-channel-1' })
    expect(id).toBe('THREAD_A')
  })

  it('bind + resolve round-trip for kind=reply', async () => {
    await bindDiscord({ kind: 'reply', key: 'discord-msg-1', threadId: 'THREAD_B' })
    expect(await resolveDiscord({ kind: 'reply', key: 'discord-msg-1' })).toBe('THREAD_B')
  })

  it('resolve missing returns undefined (does not throw)', async () => {
    const id = await resolveDiscord({ kind: 'thread', key: 'nope' })
    expect(id).toBeUndefined()
  })

  it('unbind removes the mapping; resolve then returns undefined', async () => {
    await bindDiscord({ kind: 'thread', key: 'k', threadId: 'T' })
    await unbindDiscord({ kind: 'thread', key: 'k' })
    expect(await resolveDiscord({ kind: 'thread', key: 'k' })).toBeUndefined()
  })

  it('unbind removes only the index file; underlying thread dir is untouched', async () => {
    const fs = require('node:fs') as typeof import('node:fs')
    const path = require('node:path') as typeof import('node:path')
    // Simulate a thread dir living alongside the index.
    const threadDir = path.join(TEST_GUILD_DIR, 'threads', 'THREAD_X')
    fs.mkdirSync(threadDir, { recursive: true })
    fs.writeFileSync(path.join(threadDir, 'meta.json'), JSON.stringify({ id: 'THREAD_X' }))
    await bindDiscord({ kind: 'thread', key: 'k', threadId: 'THREAD_X' })

    await unbindDiscord({ kind: 'thread', key: 'k' })

    expect(fs.existsSync(threadDir)).toBe(true)
    expect(fs.existsSync(path.join(threadDir, 'meta.json'))).toBe(true)
  })

  it('unbind of missing key is a no-op (does not throw)', async () => {
    await expect(unbindDiscord({ kind: 'thread', key: 'never-bound' })).resolves.toBeUndefined()
  })

  it('thread and reply kinds are independent namespaces', async () => {
    await bindDiscord({ kind: 'thread', key: 'shared', threadId: 'TA' })
    await bindDiscord({ kind: 'reply', key: 'shared', threadId: 'TB' })
    expect(await resolveDiscord({ kind: 'thread', key: 'shared' })).toBe('TA')
    expect(await resolveDiscord({ kind: 'reply', key: 'shared' })).toBe('TB')
  })

  it('rebind overwrites the previous mapping', async () => {
    await bindDiscord({ kind: 'thread', key: 'k', threadId: 'OLD' })
    await bindDiscord({ kind: 'thread', key: 'k', threadId: 'NEW' })
    expect(await resolveDiscord({ kind: 'thread', key: 'k' })).toBe('NEW')
  })
})
