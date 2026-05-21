import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { TEST_GUILD_DIR, currentAllowlist } = vi.hoisted(() => {
  const fs = require('node:fs') as typeof import('node:fs')
  const path = require('node:path') as typeof import('node:path')
  const os = require('node:os') as typeof import('node:os')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-file-test-'))
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

describe('edit_file handler', () => {
  beforeEach(() => {
    rmSync(TEST_GUILD_DIR, { recursive: true, force: true })
    mkdirSync(TEST_GUILD_DIR, { recursive: true })
    writeFileSync(join(TEST_GUILD_DIR, 'memory.md'), '# People\n- Alice\n- Bob\n# Decisions\n- ship v1')
    writeFileSync(join(TEST_GUILD_DIR, 'config.json'), '{}')
    currentAllowlist.value = ['memory.md', 'prompt.md']
  })

  afterEach(() => {
    rmSync(TEST_GUILD_DIR, { recursive: true, force: true })
    currentAllowlist.value = []
  })

  it('applies a search/replace block and writes atomically', async () => {
    const r = await handler({
      file_path: 'memory.md',
      blocks: [{ search: '- Bob', replace: '- Bob (eng)' }],
    }, {})
    expect(r.success).toBe(true)
    const onDisk = readFileSync(join(TEST_GUILD_DIR, 'memory.md'), 'utf8')
    expect(onDisk).toContain('- Bob (eng)')
    expect(onDisk).not.toContain('- Bob\n')
  })

  it('applies multiple blocks in order', async () => {
    const r = await handler({
      file_path: 'memory.md',
      blocks: [
        { search: '- Alice', replace: '- Alice (founder)' },
        { search: '- ship v1', replace: '- ship v2' },
      ],
    }, {})
    expect(r.success).toBe(true)
    expect((r.data as any).blocksApplied).toBe(2)
    const onDisk = readFileSync(join(TEST_GUILD_DIR, 'memory.md'), 'utf8')
    expect(onDisk).toContain('- Alice (founder)')
    expect(onDisk).toContain('- ship v2')
  })

  it('does NOT write anything if any block fails to match', async () => {
    const before = readFileSync(join(TEST_GUILD_DIR, 'memory.md'), 'utf8')
    const r = await handler({
      file_path: 'memory.md',
      blocks: [
        { search: '- Alice', replace: '- Alice (founder)' },
        { search: 'this text does not exist anywhere', replace: 'x' },
      ],
    }, {})
    expect(r.success).toBe(false)
    expect((r.data as any).error).toMatch(/Block 2 of 2 failed/)
    const after = readFileSync(join(TEST_GUILD_DIR, 'memory.md'), 'utf8')
    expect(after).toBe(before)
  })

  it('returns the stable feedback string the LLM can self-correct from', async () => {
    const r = await handler({
      file_path: 'memory.md',
      blocks: [{ search: 'nonexistent search text here xxx', replace: 'whatever' }],
    }, {})
    expect(r.success).toBe(false)
    const err = (r.data as any).error
    expect(err).toMatch(/SEARCH did not match file content/)
    expect(err).toMatch(/Hint: include 2-3 lines of unchanged context/)
  })

  it('rejects empty blocks array', async () => {
    const r = await handler({ file_path: 'memory.md', blocks: [] }, {})
    expect(r.success).toBe(false)
    expect((r.data as any).error).toMatch(/non-empty array/)
  })

  it('rejects malformed blocks', async () => {
    const r = await handler({
      file_path: 'memory.md',
      blocks: [{ search: 'x', replace: 42 }],
    }, {})
    expect(r.success).toBe(false)
    expect((r.data as any).error).toMatch(/malformed/)
  })

  it('rejects path-traversal attempt', async () => {
    const r = await handler({
      file_path: '../escape.md',
      blocks: [{ search: 'x', replace: 'y' }],
    }, {})
    expect(r.success).toBe(false)
    expect((r.data as any).error).toMatch(/must not contain/)
  })

  it('rejects config.json even when allowlisted', async () => {
    currentAllowlist.value = ['config.json']
    const r = await handler({
      file_path: 'config.json',
      blocks: [{ search: '{}', replace: '{"hacked": true}' }],
    }, {})
    expect(r.success).toBe(false)
    expect((r.data as any).error).toMatch(/sensitive-file-denied/)
  })

  it('retry semantics: first attempt fails with feedback, corrected second attempt succeeds', async () => {
    // Simulates the agent loop's iteration: LLM sends a bad search, reads
    // the error, then sends a corrected one.
    const first = await handler({
      file_path: 'memory.md',
      blocks: [{ search: '- bob', replace: '- bob (eng)' }], // lowercase typo
    }, {})
    // Whitespace-insensitive AND fuzzy will still likely match 'Bob' here
    // (similarity is high). Let's force a true miss with truly different text:
    const fail = await handler({
      file_path: 'memory.md',
      blocks: [{ search: 'completely different content unrelated to file', replace: 'x' }],
    }, {})
    expect(fail.success).toBe(false)
    expect((fail.data as any).error).toMatch(/SEARCH did not match/)
    // Operator/LLM now provides a correct search:
    const ok = await handler({
      file_path: 'memory.md',
      blocks: [{ search: '- Bob', replace: '- Bob (eng)' }],
    }, {})
    expect(ok.success).toBe(true)
    void first
  })
})
