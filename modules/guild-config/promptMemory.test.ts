// Tests for the promptMemory module.
//
// The validator is intentionally minimal: non-empty body, byte cap, and a
// secret-pattern denylist. Structure is operator-defined — no canonical
// headings, no bundled ontology.

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

Free-form notes about this guild.

- Alice prefers brevity.
- The Q2 workshop is in flight.
`

const VALID_CONFIG = {
  version: 1,
  guild: { id: 'discord:test-promptmemory', name: 'test' },
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
    writeFileSync(join(guildDir, 'config.json'), JSON.stringify(VALID_CONFIG), 'utf8')
    const secretsPath = join(guildDir, 'secrets.json')
    writeFileSync(secretsPath, JSON.stringify({ 'discord.token': 'fake' }), 'utf8')
    require('node:fs').chmodSync(secretsPath, 0o600)
  })

  afterEach(() => {
    rmSync(guildDir, { recursive: true, force: true })
    delete process.env.GUILDBOT_GUILD_DIR
  })

  // ── Deterministic concatenation ─────────────────────────────────────

  it('renderGuildSystemMessage concatenates prompt then memory in order, with two newlines between', async () => {
    const rendered = await renderGuildSystemMessage()
    expect(rendered.content).toContain('You are Atlas Bot.')
    expect(rendered.content).toContain('Free-form notes')
    // No bundled delimiter heading injected.
    expect(rendered.content).not.toContain('## Long-term memory')
    // Prompt body precedes memory body
    expect(rendered.content.indexOf('You are Atlas Bot.')).toBeLessThan(
      rendered.content.indexOf('Free-form notes'),
    )
    // No triple-newline runs from the join
    expect(rendered.content).not.toMatch(/\n\n\n/)
  })

  it('renderGuildSystemMessage handles a memory body that is just a comment', async () => {
    writeFileSync(
      join(guildDir, 'memory.md'),
      `---\nversion: 1\nupdatedAt: 2026-05-20T00:00:00.000Z\n---\n\n<!-- nothing recorded yet -->\n`,
      'utf8',
    )
    const rendered = await renderGuildSystemMessage()
    expect(rendered.content).toContain('You are Atlas Bot.')
    expect(rendered.content).toContain('<!-- nothing recorded yet -->')
  })

  // ── Snapshot dedup ──────────────────────────────────────────────────

  it('two consecutive renders with identical content yield the same snapshotPath', async () => {
    const a = await renderGuildSystemMessage()
    const b = await renderGuildSystemMessage()
    expect(a.snapshotPath).toBe(b.snapshotPath)
    expect(readdirSync(join(guildDir, 'snapshots')).length).toBe(1)
  })

  it('different renders produce different snapshot files', async () => {
    const first = await renderGuildSystemMessage()
    await updateMemory('Updated memory body.\n', { reason: 'operator:test' })
    const second = await renderGuildSystemMessage()
    expect(first.snapshotPath).not.toBe(second.snapshotPath)
    expect(readdirSync(join(guildDir, 'snapshots')).length).toBe(2)
  })

  // ── Version + history ───────────────────────────────────────────────

  it('updatePrompt increments version, updates timestamp, and writes history', async () => {
    const before = await loadPrompt()
    const result = await updatePrompt('You are Atlas Bot v2.', { reason: 'operator:42' })
    expect(result.version).toBe(before.version + 1)
    expect(result.updatedAt).not.toBe(before.updatedAt)
    const histFiles = readdirSync(join(guildDir, 'history', 'prompt'))
    expect(histFiles.length).toBe(1)
    expect(histFiles[0]).toMatch(/operator:42/)
    const prior = readFileSync(join(guildDir, 'history', 'prompt', histFiles[0]), 'utf8')
    expect(prior).toContain('You are Atlas Bot.')
  })

  it('updateMemory increments version, updates timestamp, and writes history', async () => {
    const result = await updateMemory('Whatever shape the operator wants.\n', {
      reason: 'operator:99',
    })
    expect(result.version).toBe(2)
    const histFiles = readdirSync(join(guildDir, 'history', 'memory'))
    expect(histFiles.length).toBe(1)
    expect(histFiles[0]).toMatch(/operator:99/)
  })

  // ── Snapshot semantics ──────────────────────────────────────────────

  it('editing prompt.md after a render does NOT change a previously-saved snapshot file', async () => {
    const rendered = await renderGuildSystemMessage()
    const beforeSnap = readFileSync(rendered.snapshotPath, 'utf8')
    await updatePrompt('You are Atlas Bot v2.', { reason: 'operator:test' })
    const afterSnap = readFileSync(rendered.snapshotPath, 'utf8')
    expect(afterSnap).toBe(beforeSnap)
  })

  // ── Unopinionated structure ─────────────────────────────────────────

  it('accepts memory with any top-level headings, including ones never seen before', async () => {
    const arbitrary = [
      '# Architecture decisions',
      '- We chose SQLite for the cache.',
      '',
      '# Random thoughts',
      '- This guild loves long-form essays.',
      '',
      '## A deeper section',
      '- Whatever the operator wants.',
    ].join('\n')
    const result = await updateMemory(arbitrary, { reason: 'operator:experiment' })
    expect(result.version).toBe(2)
    expect(result.content).toContain('# Architecture decisions')
  })

  it('accepts memory with no headings at all (freeform prose)', async () => {
    const result = await updateMemory(
      'This guild just keeps notes as flowing paragraphs.\nNo structure required.\n',
      { reason: 'operator:freeform' },
    )
    expect(result.version).toBe(2)
  })

  // ── Validator floor: non-empty, byte cap, secret denylist ───────────

  it('rejects an empty memory body', async () => {
    await expect(updateMemory('   \n  \n', { reason: 'operator:test' })).rejects.toThrow(
      /must not be empty/,
    )
    expect(readdirSync(join(guildDir, 'history', 'memory'))).toHaveLength(0)
  })

  it('rejects a memory body that exceeds config.memory.maxBytes', async () => {
    const huge = 'x'.repeat(40_000) // > 32_000 byte cap
    await expect(updateMemory(huge, { reason: 'operator:test' })).rejects.toThrow(
      /exceeds the byte cap/,
    )
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
      updateMemory(`Notes\n- contact: ${tokenLike}\n`, { reason: 'operator:test' }),
    ).rejects.toThrow(/secret/i)
    expect(readdirSync(join(guildDir, 'history', 'memory'))).toHaveLength(0)
  })

  it('on validator rejection, memory.md is byte-for-byte unchanged AND no history entry is written', async () => {
    const originalBytes = readFileSync(join(guildDir, 'memory.md'))
    await expect(updateMemory('   ', { reason: 'operator:test' })).rejects.toThrow()
    expect(readFileSync(join(guildDir, 'memory.md'))).toEqual(originalBytes)
    expect(readdirSync(join(guildDir, 'history', 'memory'))).toHaveLength(0)
  })

  // ── Validator integration with applyEdits ───────────────────────────

  it('a successful update DOES write a history entry; a failing one does not', async () => {
    expect(readdirSync(join(guildDir, 'history', 'memory'))).toHaveLength(0)
    await updateMemory('Some new content.\n', { reason: 'operator:happy' })
    expect(readdirSync(join(guildDir, 'history', 'memory'))).toHaveLength(1)

    await expect(updateMemory('', { reason: 'operator:sad' })).rejects.toThrow()
    expect(readdirSync(join(guildDir, 'history', 'memory'))).toHaveLength(1) // unchanged
  })

  it('updatePrompt rejects an empty body via the prompt validator', async () => {
    await expect(updatePrompt('   \n  \n', { reason: 'operator:test' })).rejects.toThrow(
      /must not be empty/,
    )
  })

  // ── Loaders hit disk every call ─────────────────────────────────────

  it('loadPrompt / loadMemory hit disk on every call (no module-level cache)', async () => {
    const first = await loadMemory()
    expect(first.content).toContain('Free-form notes')
    writeFileSync(
      join(guildDir, 'memory.md'),
      `---\nversion: 7\nupdatedAt: 2026-06-01T00:00:00.000Z\n---\n\nDifferent content entirely.\n`,
      'utf8',
    )
    const second = await loadMemory()
    expect(second.content).toContain('Different content entirely')
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
