import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initGuildDir } from './initGuildDir'
import { loadConfig } from './loadConfig'

describe('initGuildDir', () => {
  let guildDir: string
  let codebaseRoot: string

  beforeEach(() => {
    guildDir = mkdtempSync(join(tmpdir(), 'guildbot-init-test-'))
    codebaseRoot = mkdtempSync(join(tmpdir(), 'guildbot-codebase-test-'))
    mkdirSync(join(codebaseRoot, 'tools', 'sample'), { recursive: true })
    writeFileSync(join(codebaseRoot, 'tools', 'sample', 'definition.json'), '{}')
    mkdirSync(join(codebaseRoot, 'skills', 'sample'), { recursive: true })
    writeFileSync(join(codebaseRoot, 'skills', 'sample', 'SKILL.md'), '---\nname: sample\n---')
    mkdirSync(join(codebaseRoot, 'guild-defaults'), { recursive: true })
    writeFileSync(join(codebaseRoot, 'guild-defaults', 'prompt.md'), 'You are GuildBot.')
    writeFileSync(join(codebaseRoot, 'guild-defaults', 'memory.md'), '# People\n')
  })
  afterEach(() => {
    rmSync(guildDir, { recursive: true, force: true })
    rmSync(codebaseRoot, { recursive: true, force: true })
  })

  it('creates all data subdirs', () => {
    initGuildDir(guildDir, { codebaseRoot })
    for (const sub of [
      'db',
      'recordings',
      'sessions',
      'sessions/context',
      'media',
      'exports',
      'threads',
      'history',
      'history/prompt',
      'history/memory',
      'snapshots',
    ]) {
      expect(existsSync(join(guildDir, sub)), `missing ${sub}`).toBe(true)
    }
  })

  it('writes a default config.json on first run', () => {
    initGuildDir(guildDir, { codebaseRoot })
    expect(existsSync(join(guildDir, 'config.json'))).toBe(true)
    const cfg = JSON.parse(readFileSync(join(guildDir, 'config.json'), 'utf8'))
    expect(cfg.version).toBe(1)
    expect(cfg.discord.token).toEqual({ $secret: 'discord.token' })
  })

  it('merges config overrides on top of defaults', () => {
    initGuildDir(guildDir, {
      codebaseRoot,
      config: { guild: { id: 'discord:abc', name: 'abc' }, llm: { provider: 'openai-compat' } },
    })
    const cfg = JSON.parse(readFileSync(join(guildDir, 'config.json'), 'utf8'))
    expect(cfg.guild.id).toBe('discord:abc')
    expect(cfg.llm.provider).toBe('openai-compat')
    // Default values still present
    expect(cfg.llm.models.default).toBe('qwen3.6')
  })

  it('does NOT overwrite existing config.json on re-run', () => {
    initGuildDir(guildDir, { codebaseRoot })
    const before = readFileSync(join(guildDir, 'config.json'), 'utf8')
    initGuildDir(guildDir, { codebaseRoot })
    const after = readFileSync(join(guildDir, 'config.json'), 'utf8')
    expect(after).toBe(before)
  })

  it('writes secrets.json with mode 0600', () => {
    initGuildDir(guildDir, { codebaseRoot, secrets: { 'discord.token': 'abc' } })
    const stat = statSync(join(guildDir, 'secrets.json'))
    expect((stat.mode & 0o777).toString(8)).toBe('600')
    expect(JSON.parse(readFileSync(join(guildDir, 'secrets.json'), 'utf8'))).toEqual({ 'discord.token': 'abc' })
  })

  it('creates an empty secrets.json when none supplied (so permission check has a file)', () => {
    initGuildDir(guildDir, { codebaseRoot })
    expect(existsSync(join(guildDir, 'secrets.json'))).toBe(true)
    expect(JSON.parse(readFileSync(join(guildDir, 'secrets.json'), 'utf8'))).toEqual({})
  })

  it('merges new secrets into an existing secrets.json', () => {
    initGuildDir(guildDir, { codebaseRoot, secrets: { 'discord.token': 'first' } })
    initGuildDir(guildDir, { codebaseRoot, secrets: { 'llm.apiKey': 'second' } })
    const secrets = JSON.parse(readFileSync(join(guildDir, 'secrets.json'), 'utf8'))
    expect(secrets).toEqual({ 'discord.token': 'first', 'llm.apiKey': 'second' })
  })

  it('seeds tools/ and skills/ from codebase', () => {
    initGuildDir(guildDir, { codebaseRoot })
    expect(existsSync(join(guildDir, 'tools', 'sample', 'definition.json'))).toBe(true)
    expect(existsSync(join(guildDir, 'skills', 'sample', 'SKILL.md'))).toBe(true)
  })

  it('resyncs tools/ and skills/ on every call (overwrites stale codebase files)', async () => {
    initGuildDir(guildDir, { codebaseRoot })
    // Simulate a stale per-guild copy: replace the definition.json with old content
    const defPath = join(guildDir, 'tools', 'sample', 'definition.json')
    const { writeFileSync, readFileSync } = await import('node:fs')
    writeFileSync(defPath, '"stale"')

    // Re-invoke; should overwrite the stale copy with the fresh codebase version
    initGuildDir(guildDir, { codebaseRoot })
    expect(readFileSync(defPath, 'utf-8')).toBe('{}')
  })

  it('preserves orphan per-guild tools (operator customisations) across resyncs', async () => {
    initGuildDir(guildDir, { codebaseRoot })
    const { writeFileSync, mkdirSync, existsSync } = await import('node:fs')
    mkdirSync(join(guildDir, 'tools', 'custom-tool'), { recursive: true })
    writeFileSync(join(guildDir, 'tools', 'custom-tool', 'definition.json'), '{}')

    initGuildDir(guildDir, { codebaseRoot })
    expect(existsSync(join(guildDir, 'tools', 'custom-tool', 'definition.json'))).toBe(true)
    // codebase tool still there too
    expect(existsSync(join(guildDir, 'tools', 'sample', 'definition.json'))).toBe(true)
  })

  it('seeds prompt.md and memory.md from guild-defaults/', () => {
    initGuildDir(guildDir, { codebaseRoot })
    expect(readFileSync(join(guildDir, 'prompt.md'), 'utf8')).toBe('You are GuildBot.')
    expect(readFileSync(join(guildDir, 'memory.md'), 'utf8')).toBe('# People\n')
  })

  it('produces a guild dir loadConfig() can read end-to-end', () => {
    initGuildDir(guildDir, {
      codebaseRoot,
      config: { guild: { id: 'discord:end-to-end', name: 'e2e' } },
      secrets: { 'discord.token': 'token' },
    })
    const cfg = loadConfig(guildDir)
    expect(cfg.guild.id).toBe('discord:end-to-end')
    expect(cfg.discord.token).toBe('token')
  })
})
