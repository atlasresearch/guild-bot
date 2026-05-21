// Tests for plan 007's promptMemory module.
//
// Covers R6.1 (deterministic render), R6.2 (snapshot dedup), R6.3 (version +
// history), R6.4 (snapshot semantics — already-rendered snapshot survives a
// later edit), R6.7 (canonical-heading enforcement + no history on failure),
// R6.9 (validator integration with applyEdits).

import {
  existsSync,
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
  loadMemory,
  loadPrompt,
  renderGuildSystemMessage,
  updateMemory,
  updatePrompt,
} from './promptMemory'

const SEED_PROMPT = `---
version: 1
updatedAt: 2026-05-20T00:00:00.000Z
---

You are Atlas Bot.
`

const SEED_MEMORY = `---
version: 1
updatedAt: 2026-05-20T00:00:00.000Z
---

# People
- Alice

# Ongoing projects

# Decisions

# Norms learned
`

describe('promptMemory module', () => {
  let guildDir: string

  beforeEach(() => {
    guildDir = mkdtempSync(join(tmpdir(), 'guildbot-prompt-memory-test-'))
    process.env.GUILDBOT_GUILD_DIR = guildDir
    mkdirSync(join(guildDir, 'history', 'prompt'), { recursive: true })
    mkdirSync(join(guildDir, 'history', 'memory'), { recursive: true })
    mkdirSync(join(guildDir, 'snapshots'), { recursive: true })
    writeFileSync(join(guildDir, 'prompt.md'), SEED_PROMPT, 'utf8')
    writeFileSync(join(guildDir, 'memory.md'), SEED_MEMORY, 'utf8')
  })

  afterEach(() => {
    rmSync(guildDir, { recursive: true, force: true })
    delete process.env.GUILDBOT_GUILD_DIR
  })

  // ── R6.1: deterministic concatenation ─────────────────────────────────────

  it('renderGuildSystemMessage concatenates prompt + memory in the documented order', async () => {
    const rendered = await renderGuildSystemMessage()
    expect(rendered.content).toContain('You are Atlas Bot.')
    expect(rendered.content).toContain('## Long-term memory')
    expect(rendered.content).toContain('# People')
    expect(rendered.content).toContain('- Alice')
    // The heading must come AFTER the prompt body
    expect(rendered.content.indexOf('You are Atlas Bot.')).toBeLessThan(
      rendered.content.indexOf('## Long-term memory'),
    )
    // The memory body comes AFTER the heading
    expect(rendered.content.indexOf('## Long-term memory')).toBeLessThan(
      rendered.content.indexOf('# People'),
    )
  })

  it('renderGuildSystemMessage produces the exact R2.3 join (two newlines, heading, two newlines)', async () => {
    const rendered = await renderGuildSystemMessage()
    // The heading is preceded by exactly two newlines and followed by exactly two newlines.
    // No triple-newline blocks anywhere.
    expect(rendered.content).not.toMatch(/\n\n\n/)
    expect(rendered.content).toContain('\n\n## Long-term memory\n\n')
  })

  it('renderGuildSystemMessage emits the heading even when memory body is empty', async () => {
    writeFileSync(
      join(guildDir, 'memory.md'),
      `---\nversion: 1\nupdatedAt: 2026-05-20T00:00:00.000Z\n---\n\n# People\n\n# Ongoing projects\n\n# Decisions\n\n# Norms learned\n`,
      'utf8',
    )
    const rendered = await renderGuildSystemMessage()
    expect(rendered.content).toContain('## Long-term memory')
  })

  // ── R6.2: snapshot dedup ──────────────────────────────────────────────────

  it('two consecutive renders with identical content yield the same snapshotPath', async () => {
    const a = await renderGuildSystemMessage()
    const b = await renderGuildSystemMessage()
    expect(a.snapshotPath).toBe(b.snapshotPath)
    const dirEntries = readdirSync(join(guildDir, 'snapshots'))
    expect(dirEntries.length).toBe(1)
  })

  it('different renders produce different snapshot files', async () => {
    const first = await renderGuildSystemMessage()
    // mutate memory
    await updateMemory(
      `\n# People\n- Alice\n- Bob\n\n# Ongoing projects\n\n# Decisions\n\n# Norms learned\n`,
      { reason: 'operator:test' },
    )
    const second = await renderGuildSystemMessage()
    expect(first.snapshotPath).not.toBe(second.snapshotPath)
    const dirEntries = readdirSync(join(guildDir, 'snapshots'))
    expect(dirEntries.length).toBe(2)
  })

  // ── R6.3: version + history ───────────────────────────────────────────────

  it('updatePrompt increments version, updates timestamp, and writes history', async () => {
    const before = await loadPrompt()
    const result = await updatePrompt('You are Atlas Bot v2.', {
      reason: 'operator:42',
    })
    expect(result.version).toBe(before.version + 1)
    expect(result.updatedAt).not.toBe(before.updatedAt)
    const histFiles = readdirSync(join(guildDir, 'history', 'prompt'))
    expect(histFiles.length).toBe(1)
    expect(histFiles[0]).toMatch(/operator:42/)
    // History file holds the *previous* content
    const prior = readFileSync(join(guildDir, 'history', 'prompt', histFiles[0]), 'utf8')
    expect(prior).toContain('You are Atlas Bot.')
  })

  it('updateMemory increments version, updates timestamp, and writes history', async () => {
    const result = await updateMemory(
      `\n# People\n- Alice\n- Bob\n\n# Ongoing projects\n\n# Decisions\n\n# Norms learned\n`,
      { reason: 'operator:99' },
    )
    expect(result.version).toBe(2)
    const histFiles = readdirSync(join(guildDir, 'history', 'memory'))
    expect(histFiles.length).toBe(1)
    expect(histFiles[0]).toMatch(/operator:99/)
  })

  // ── R6.4: snapshot semantics ──────────────────────────────────────────────

  it('editing prompt.md after a render does NOT change a previously-saved snapshot file', async () => {
    const rendered = await renderGuildSystemMessage()
    const beforeSnap = readFileSync(rendered.snapshotPath, 'utf8')
    await updatePrompt('You are Atlas Bot v2.', { reason: 'operator:test' })
    const afterSnap = readFileSync(rendered.snapshotPath, 'utf8')
    expect(afterSnap).toBe(beforeSnap)
  })

  // ── R6.7 + R6.9: canonical-heading validator on memory, no history on fail

  it('rejects memory writes that add a non-canonical top-level heading', async () => {
    await expect(
      updateMemory(
        `\n# People\n\n# Ongoing projects\n\n# Decisions\n\n# Norms learned\n\n# Random Heading\n- not allowed\n`,
        { reason: 'operator:test' },
      ),
    ).rejects.toThrow(/canonical top-level headings/)
  })

  it('rejects memory writes that omit a required heading', async () => {
    await expect(
      updateMemory(
        `\n# People\n\n# Ongoing projects\n\n# Decisions\n`,
        { reason: 'operator:test' },
      ),
    ).rejects.toThrow(/missing the required heading/)
  })

  it('on validator rejection, memory.md is byte-for-byte unchanged AND no history entry is written', async () => {
    const originalBytes = readFileSync(join(guildDir, 'memory.md'))
    await expect(
      updateMemory(
        `\n# People\n\n# Ongoing projects\n\n# Decisions\n\n# Norms learned\n\n# Bogus\n`,
        { reason: 'operator:test' },
      ),
    ).rejects.toThrow()
    expect(readFileSync(join(guildDir, 'memory.md'))).toEqual(originalBytes)
    expect(readdirSync(join(guildDir, 'history', 'memory'))).toHaveLength(0)
  })

  it('rejects memory containing a Discord-token-shaped secret', async () => {
    // Assembled at runtime so the literal token shape never appears in source
    // (GitHub's secret-scanning regex matches against file contents).
    const tokenLike = [
      'FAKE-TOKEN-FOR-TEST-ONLY-XXXX',
      'NOTREAL',
      'THIS-IS-NOT-A-REAL-DISCORD-BOT-TOKEN',
    ].join('.')
    await expect(
      updateMemory(
        `\n# People\n- contact: ${tokenLike}\n\n# Ongoing projects\n\n# Decisions\n\n# Norms learned\n`,
        { reason: 'operator:test' },
      ),
    ).rejects.toThrow(/secret/i)
    expect(readdirSync(join(guildDir, 'history', 'memory'))).toHaveLength(0)
  })

  // ── R6.9: validator integration with applyEdits — success writes history ─

  it('a successful update DOES write a history entry; a failing one does not', async () => {
    const startHistory = readdirSync(join(guildDir, 'history', 'memory'))
    expect(startHistory).toHaveLength(0)
    await updateMemory(
      `\n# People\n- Alice\n- Bob\n\n# Ongoing projects\n\n# Decisions\n\n# Norms learned\n`,
      { reason: 'operator:happy' },
    )
    const afterSuccess = readdirSync(join(guildDir, 'history', 'memory'))
    expect(afterSuccess).toHaveLength(1)

    await expect(
      updateMemory(`\n# Bogus\n`, { reason: 'operator:sad' }),
    ).rejects.toThrow()
    const afterFailure = readdirSync(join(guildDir, 'history', 'memory'))
    expect(afterFailure).toHaveLength(1) // unchanged
  })

  it('updatePrompt rejects an empty body via the prompt validator', async () => {
    await expect(updatePrompt('   \n  \n', { reason: 'operator:test' })).rejects.toThrow(
      /must not be empty/,
    )
  })

  // ── R2.2: loaders hit disk every call ─────────────────────────────────────

  it('loadPrompt / loadMemory hit disk on every call (no module-level cache)', async () => {
    const first = await loadMemory()
    expect(first.content).toContain('- Alice')
    writeFileSync(
      join(guildDir, 'memory.md'),
      `---\nversion: 7\nupdatedAt: 2026-06-01T00:00:00.000Z\n---\n\n# People\n- Eve\n\n# Ongoing projects\n\n# Decisions\n\n# Norms learned\n`,
      'utf8',
    )
    const second = await loadMemory()
    expect(second.content).toContain('- Eve')
    expect(second.version).toBe(7)
  })

  it('loadMemory reports byteSize of the body (no frontmatter included)', async () => {
    const m = await loadMemory()
    expect(m.byteSize).toBe(Buffer.byteLength(m.content, 'utf8'))
    expect(m.content).not.toContain('updatedAt:')
  })

  it('snapshot dir exists; render writes inside it', async () => {
    const rendered = await renderGuildSystemMessage()
    expect(existsSync(rendered.snapshotPath)).toBe(true)
    expect(rendered.snapshotPath.startsWith(join(guildDir, 'snapshots'))).toBe(true)
  })
})
