// Tests for the operator-facing helpers: forget (R6.6), listHistory, revert,
// and diffAgainstDefault.

import {
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

# People
- Alice
- secret_target: hunter2 password reminder

# Ongoing projects

# Decisions

# Norms learned
`

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
    mkdirSync(join(codebaseRoot, 'guild-defaults'), { recursive: true })
    writeFileSync(
      join(codebaseRoot, 'guild-defaults', 'prompt.md'),
      `---\nversion: 0\n---\n\nYou are Guild Bot.\n`,
      'utf8',
    )
    writeFileSync(
      join(codebaseRoot, 'guild-defaults', 'memory.md'),
      `---\nversion: 0\n---\n\n# People\n\n# Ongoing projects\n\n# Decisions\n\n# Norms learned\n`,
      'utf8',
    )
  })

  afterEach(() => {
    rmSync(guildDir, { recursive: true, force: true })
    rmSync(codebaseRoot, { recursive: true, force: true })
    delete process.env.GUILDBOT_GUILD_DIR
  })

  // ── R6.6: forget ──────────────────────────────────────────────────────────

  it('forgetMemory removes the matching content and records an audit-log entry', async () => {
    const result = await forgetMemory('the hunter2 password reminder', {
      runStructured: async () => ({
        rewrittenMemory:
          '\n# People\n- Alice\n\n# Ongoing projects\n\n# Decisions\n\n# Norms learned\n',
        removed: ['secret_target: hunter2 password reminder'],
      }),
    })
    expect(result.removed).toContain('secret_target: hunter2 password reminder')
    expect(result.after.version).toBe(2)

    // memory.md no longer contains the removed line
    const live = readFileSync(join(guildDir, 'memory.md'), 'utf8')
    expect(live).not.toContain('hunter2')
    expect(live).toContain('- Alice')

    // History entry exists with reason: forget:<pattern>
    const histFiles = readdirSync(join(guildDir, 'history', 'memory'))
    expect(histFiles).toHaveLength(1)
    expect(histFiles[0]).toMatch(/forget:/)
    // The history file holds the PRE-forget content with the secret line.
    const histContent = readFileSync(
      join(guildDir, 'history', 'memory', histFiles[0]),
      'utf8',
    )
    expect(histContent).toContain('hunter2')
  })

  it('forgetMemory routes through updateMemory so the canonical-heading validator runs', async () => {
    // The mocked LLM returns invalid memory (extra heading) — updateMemory must reject.
    await expect(
      forgetMemory('anything', {
        runStructured: async () => ({
          rewrittenMemory: '\n# Bogus\n',
          removed: ['everything'],
        }),
      }),
    ).rejects.toThrow(/canonical top-level headings|missing the required heading/)

    // No history entry should be written for the failed call.
    const histFiles = readdirSync(join(guildDir, 'history', 'memory'))
    expect(histFiles).toHaveLength(0)
  })

  // ── listHistory + revert ──────────────────────────────────────────────────

  it('lists history entries newest-first, parsing timestamp and reason', async () => {
    await updateMemory(
      '\n# People\n- v2\n\n# Ongoing projects\n\n# Decisions\n\n# Norms learned\n',
      { reason: 'operator:abc' },
    )
    // Force a different timestamp slug
    await new Promise((r) => setTimeout(r, 5))
    await updateMemory(
      '\n# People\n- v3\n\n# Ongoing projects\n\n# Decisions\n\n# Norms learned\n',
      { reason: 'operator:xyz' },
    )
    const entries = listHistory('memory')
    expect(entries.length).toBe(2)
    // Newest-first
    expect(entries[0].filename.localeCompare(entries[1].filename)).toBeGreaterThan(0)
    expect(entries[0].reason).toMatch(/operator:/)
  })

  it('revert restores prior content and bumps the version', async () => {
    const before = await loadMemory()
    await updateMemory(
      '\n# People\n- changed\n\n# Ongoing projects\n\n# Decisions\n\n# Norms learned\n',
      { reason: 'operator:test' },
    )
    const entries = listHistory('memory')
    expect(entries).toHaveLength(1)
    await revert('memory', entries[0].filename, 'rollback')
    const after = await loadMemory()
    expect(after.content).toContain(before.content.trim())
    expect(after.version).toBeGreaterThan(before.version)
  })

  // ── diffAgainstDefault ───────────────────────────────────────────────────

  it('diffAgainstDefault returns empty string when live file equals default', async () => {
    // make memory match default
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
