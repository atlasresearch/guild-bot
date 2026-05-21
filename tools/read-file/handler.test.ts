import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { TEST_GUILD_DIR, currentAllowlist } = vi.hoisted(() => {
  const fs = require('node:fs') as typeof import('node:fs')
  const path = require('node:path') as typeof import('node:path')
  const os = require('node:os') as typeof import('node:os')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-file-test-'))
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

describe('read_file handler', () => {
  beforeEach(() => {
    rmSync(TEST_GUILD_DIR, { recursive: true, force: true })
    mkdirSync(TEST_GUILD_DIR, { recursive: true })
    writeFileSync(join(TEST_GUILD_DIR, 'prompt.md'), 'line 1\nline 2\nline 3')
    writeFileSync(join(TEST_GUILD_DIR, 'memory.md'), '# memory\n- item')
    writeFileSync(join(TEST_GUILD_DIR, 'secrets.json'), '{}')
    currentAllowlist.value = ['prompt.md', 'memory.md']
  })

  afterEach(() => {
    rmSync(TEST_GUILD_DIR, { recursive: true, force: true })
    currentAllowlist.value = []
  })

  it('returns content + lineCount + numberedView for an allowlisted file', async () => {
    const r = await handler({ file_path: 'prompt.md' }, {})
    expect(r.success).toBe(true)
    expect((r.data as any).content).toBe('line 1\nline 2\nline 3')
    expect((r.data as any).lineCount).toBe(3)
    expect((r.data as any).numberedView).toBe('1: line 1\n2: line 2\n3: line 3')
    expect((r.data as any).file_path).toBe('prompt.md')
  })

  it('rejects an empty allowlist with the operator-fix hint', async () => {
    currentAllowlist.value = []
    const r = await handler({ file_path: 'prompt.md' }, {})
    expect(r.success).toBe(false)
    expect((r.data as any).error).toMatch(/config\.tools\.editAllowlist is empty/)
  })

  it('rejects an absolute file_path', async () => {
    const r = await handler({ file_path: '/etc/passwd' }, {})
    expect(r.success).toBe(false)
    expect((r.data as any).error).toMatch(/must be relative/)
  })

  it('rejects file_path containing ..', async () => {
    const r = await handler({ file_path: '../something' }, {})
    expect(r.success).toBe(false)
    expect((r.data as any).error).toMatch(/must not contain/)
  })

  it('rejects secrets.json even when allowlisted', async () => {
    currentAllowlist.value = ['secrets.json']
    const r = await handler({ file_path: 'secrets.json' }, {})
    expect(r.success).toBe(false)
    expect((r.data as any).error).toMatch(/sensitive-file-denied/)
  })

  it('returns a clear error for missing file', async () => {
    currentAllowlist.value = ['ghost.md']
    const r = await handler({ file_path: 'ghost.md' }, {})
    expect(r.success).toBe(false)
    expect((r.data as any).error).toMatch(/File not found/)
  })
})
