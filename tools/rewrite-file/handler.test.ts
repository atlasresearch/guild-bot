import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { TEST_GUILD_DIR, currentAllowlist } = vi.hoisted(() => {
  const fs = require('node:fs') as typeof import('node:fs')
  const path = require('node:path') as typeof import('node:path')
  const os = require('node:os') as typeof import('node:os')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rewrite-file-test-'))
  const state = { value: [] as string[] }
  return { TEST_GUILD_DIR: dir as string, currentAllowlist: state }
})

vi.mock('@guildbot/guild-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@guildbot/guild-config')>()
  return {
    ...actual,
    paths: () => actual.paths(TEST_GUILD_DIR),
    loadConfig: () => ({
      tools: { disabled: [], editAllowlist: currentAllowlist.value },
    }) as any,
  }
})

import handler from './handler'

describe('rewrite_file handler', () => {
  beforeEach(() => {
    rmSync(TEST_GUILD_DIR, { recursive: true, force: true })
    mkdirSync(TEST_GUILD_DIR, { recursive: true })
    writeFileSync(join(TEST_GUILD_DIR, 'memory.md'), 'original')
    writeFileSync(join(TEST_GUILD_DIR, 'secrets.json'), '{}')
    currentAllowlist.value = ['memory.md', 'snippets/*.md', 'prompt.md']
  })

  afterEach(() => {
    rmSync(TEST_GUILD_DIR, { recursive: true, force: true })
    currentAllowlist.value = []
  })

  it('replaces an existing file wholesale and writes atomically', async () => {
    const r = await handler({ file_path: 'memory.md', content: 'rewritten body' }, {})
    expect(r.success).toBe(true)
    expect(readFileSync(join(TEST_GUILD_DIR, 'memory.md'), 'utf8')).toBe('rewritten body')
  })

  it('creates a new file under an allowlisted directory', async () => {
    mkdirSync(join(TEST_GUILD_DIR, 'snippets'), { recursive: true })
    const r = await handler({ file_path: 'snippets/new.md', content: '# fresh' }, {})
    expect(r.success).toBe(true)
    expect(existsSync(join(TEST_GUILD_DIR, 'snippets', 'new.md'))).toBe(true)
    expect(readFileSync(join(TEST_GUILD_DIR, 'snippets', 'new.md'), 'utf8')).toBe('# fresh')
  })

  it('rejects when content is not a string', async () => {
    const r = await handler({ file_path: 'memory.md', content: 123 }, {})
    expect(r.success).toBe(false)
    expect((r.data as any).error).toMatch(/content must be a string/)
  })

  it('rejects secrets.json regardless of allowlist', async () => {
    currentAllowlist.value = ['*']
    const r = await handler({ file_path: 'secrets.json', content: '{"hacked":true}' }, {})
    expect(r.success).toBe(false)
    expect((r.data as any).error).toMatch(/sensitive-file-denied/)
  })

  it('rejects empty allowlist with helpful message', async () => {
    currentAllowlist.value = []
    const r = await handler({ file_path: 'memory.md', content: 'x' }, {})
    expect(r.success).toBe(false)
    expect((r.data as any).error).toMatch(/config\.tools\.editAllowlist is empty/)
  })
})
