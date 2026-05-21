// Tests for the operator-facing helpers: forget, listHistory, revert,
// and diffAgainstDefault.

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
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  diffAgainstDefault,
  forgetMemory,
  listHistory,
  revert,
} from './promptMemoryOps'
import { loadMemory, updateMemory } from './promptMemory'

const SEED_MEMORY = `---
version: 1
updatedAt: 2026-05-20T00:00:00.000Z
---

- Alice prefers brevity.
- secret_target: hunter2 password reminder
- The Q2 workshop is in flight.
`

const VALID_CONFIG = {
  version: 1,
  guild: { id: 'discord:test-ops', name: 'test' },
  discord: { token: { $secret: 'discord.token' } },
  llm: {
    provider: 'ollama',
    baseUrl: 'http://localhost:11434',
    models: { default: 'qwen3.6', embed: 'nomic-embed-text' },
    embed: {},
  },
  recording: {},
  threads: { compaction: { thresholdMessages: 60, thresholdTokens: 20000, keepLastN: 10 } },
  memory: { maxBytes: 32000, extractionEnabled: true, operatorRoleIds: [] },
  tools: { disabled: [], editAllowlist: ['prompt.md', 'memory.md'] },
}

describe('promptMemoryOps', () => {
  let guildDir: string
  let codebaseRoot: string

  beforeEach(() => {
    guildDir = mkdtempSync(join(tmpdir(), 'guildbot-ops-test-'))
    codebaseRoot = mkdtempSync(join(tmpdir(), 'guildbot-codebase-test-'))
    process.env.GUILDBOT_GUILD_DIR = guildDir
    mkdirSync(join(guildDir, 'history', 'prompt'), { recursive: true })
    mkdirSync(join(guildDir, 'history', 'memory'), { recursive: true })
    mkdirSync(join(guildDir, 'snapshots'), { recursive: true })
    writeFileSync(join(guildDir, 'memory.md'), SEED_MEMORY, 'utf8')
    writeFileSync(
      join(guildDir, 'prompt.md'),
      `---\nversion: 1\nupdatedAt: 2026-05-20T00:00:00.000Z\n---\n\nYou are Atlas Bot.\n`,
      'utf8',
    )
    writeFileSync(join(guildDir, 'config.json'), JSON.stringify(VALID_CONFIG), 'utf8')
    const secretsPath = join(guildDir, 'secrets.json')
    writeFileSync(secretsPath, JSON.stringify({ 'discord.token': 'fake' }), 'utf8')
    chmodSync(secretsPath, 0o600)

    mkdirSync(join(codebaseRoot, 'guild-defaults'), { recursive: true })
    writeFileSync(
      join(codebaseRoot, 'guild-defaults', 'prompt.md'),
      `---\nversion: 0\n---\n\nYou are Guild Bot.\n`,
      'utf8',
    )
    writeFileSync(
      join(codebaseRoot, 'guild-defaults', 'memory.md'),
      `---\nversion: 0\n---\n\n<!-- empty -->\n`,
      'utf8',
    )
  })

  afterEach(() => {
    rmSync(guildDir, { recursive: true, force: true })
    rmSync(codebaseRoot, { recursive: true, force: true })
    delete process.env.GUILDBOT_GUILD_DIR
  })

  // ── forget ──────────────────────────────────────────────────────────────

  it('forgetMemory removes the matching content and records an audit-log entry', async () => {
    const result = await forgetMemory('the hunter2 password reminder', {
      runStructured: async () => ({
        rewrittenMemory:
          '- Alice prefers brevity.\n- The Q2 workshop is in flight.\n',
        removed: ['secret_target: hunter2 password reminder'],
      }),
    })
    expect(result.removed).toContain('secret_target: hunter2 password reminder')
    expect(result.after.version).toBe(2)

    const live = readFileSync(join(guildDir, 'memory.md'), 'utf8')
    expect(live).not.toContain('hunter2')
    expect(live).toContain('Alice prefers brevity')

    // History entry exists with reason: forget:<pattern>
    const histFiles = readdirSync(join(guildDir, 'history', 'memory'))
    expect(histFiles).toHaveLength(1)
    expect(histFiles[0]).toMatch(/forget:/)
    const histContent = readFileSync(
      join(guildDir, 'history', 'memory', histFiles[0]),
      'utf8',
    )
    expect(histContent).toContain('hunter2')
  })

  it('forgetMemory routes through updateMemory so the validator floor runs', async () => {
    // Empty rewrite is rejected by updateMemory's non-empty check.
    await expect(
      forgetMemory('anything', {
        runStructured: async () => ({
          rewrittenMemory: '   ',
          removed: ['everything'],
        }),
      }),
    ).rejects.toThrow(/must not be empty/)

    expect(readdirSync(join(guildDir, 'history', 'memory'))).toHaveLength(0)
  })

  // ── listHistory + revert ─────────────────────────────────────────────────

  it('lists history entries newest-first, parsing timestamp and reason', async () => {
    await updateMemory('- v2 content\n', { reason: 'operator:abc' })
    // Force a different timestamp slug
    await new Promise((r) => setTimeout(r, 5))
    await updateMemory('- v3 content\n', { reason: 'operator:xyz' })
    const entries = listHistory('memory')
    expect(entries.length).toBe(2)
    expect(entries[0].filename.localeCompare(entries[1].filename)).toBeGreaterThan(0)
    expect(entries[0].reason).toMatch(/operator:/)
  })

  it('revert restores prior content and bumps the version', async () => {
    const before = await loadMemory()
    await updateMemory('- changed\n', { reason: 'operator:test' })
    const entries = listHistory('memory')
    expect(entries).toHaveLength(1)
    await revert('memory', entries[0].filename, 'rollback')
    const after = await loadMemory()
    expect(after.content).toContain(before.content.trim())
    expect(after.version).toBeGreaterThan(before.version)
  })

  // ── diffAgainstDefault ───────────────────────────────────────────────────

  it('diffAgainstDefault returns empty string when live file equals default', async () => {
    writeFileSync(
      join(guildDir, 'memory.md'),
      readFileSync(join(codebaseRoot, 'guild-defaults', 'memory.md'), 'utf8'),
      'utf8',
    )
    const diff = await diffAgainstDefault('memory', codebaseRoot)
    expect(diff).toBe('')
  })

  it('diffAgainstDefault returns a unified diff when they differ', async () => {
    const diff = await diffAgainstDefault('prompt', codebaseRoot)
    expect(diff).toContain('--- default/prompt.md')
    expect(diff).toContain('+++ prompt.md (live)')
    expect(diff).toContain('+You are Atlas Bot.')
    expect(diff).toContain('-You are Guild Bot.')
  })
})
