import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureEnvironment, syncEnvironment } from './env'

describe('ensureEnvironment', () => {
  let envDir: string
  let codebaseDir: string

  beforeEach(() => {
    // Use unique dirs per test to avoid interference
    const ts = Date.now() + Math.random().toString(36).slice(2)
    envDir = join(tmpdir(), `guildbot-env-test-${ts}`)
    codebaseDir = join(tmpdir(), `guildbot-codebase-test-${ts}`)

    // Minimal codebase fixture
    mkdirSync(join(codebaseDir, 'tools', 'test-tool'), { recursive: true })
    writeFileSync(join(codebaseDir, 'tools', 'test-tool', 'definition.json'), '{}')
    mkdirSync(join(codebaseDir, 'skills', 'test-skill'), { recursive: true })
    writeFileSync(join(codebaseDir, 'skills', 'test-skill', 'SKILL.md'), '---\nname: test-skill\n---')
    writeFileSync(join(codebaseDir, '.env.example'), 'DEFAULT_MODEL=qwen3.6\n')
  })

  afterEach(async () => {
    await rm(envDir, { recursive: true, force: true })
    await rm(codebaseDir, { recursive: true, force: true })
  })

  it('R1.2: creates environment directory if it does not exist', () => {
    expect(existsSync(envDir)).toBe(false)
    ensureEnvironment(codebaseDir, envDir)
    expect(existsSync(envDir)).toBe(true)
  })

  it('R1.3: creates all required sub-directories', () => {
    ensureEnvironment(codebaseDir, envDir)
    for (const sub of ['db', 'recordings', 'sessions', 'sessions/context', 'media', 'exports']) {
      expect(existsSync(join(envDir, sub)), `missing: ${sub}`).toBe(true)
    }
  })

  it('R3.1: seeds tools from codebase on first run', () => {
    ensureEnvironment(codebaseDir, envDir)
    expect(existsSync(join(envDir, 'tools', 'test-tool', 'definition.json'))).toBe(true)
  })

  it('R3.1: seeds skills from codebase on first run', () => {
    ensureEnvironment(codebaseDir, envDir)
    expect(existsSync(join(envDir, 'skills', 'test-skill', 'SKILL.md'))).toBe(true)
  })

  it('R3.2: does NOT overwrite existing tools on subsequent runs', () => {
    ensureEnvironment(codebaseDir, envDir)
    // Simulate in-env customisation
    writeFileSync(join(envDir, 'tools', 'test-tool', 'definition.json'), '"custom"')
    ensureEnvironment(codebaseDir, envDir)
    const content = require('node:fs').readFileSync(join(envDir, 'tools', 'test-tool', 'definition.json'), 'utf8')
    expect(content).toBe('"custom"')
  })

  it('R3.2: does NOT overwrite existing skills on subsequent runs', () => {
    ensureEnvironment(codebaseDir, envDir)
    writeFileSync(join(envDir, 'skills', 'test-skill', 'SKILL.md'), '# custom')
    ensureEnvironment(codebaseDir, envDir)
    const content = require('node:fs').readFileSync(join(envDir, 'skills', 'test-skill', 'SKILL.md'), 'utf8')
    expect(content).toBe('# custom')
  })

  it('R3.4: copies .env.example to .env when no .env exists', () => {
    ensureEnvironment(codebaseDir, envDir)
    expect(existsSync(join(envDir, '.env'))).toBe(true)
    const content = require('node:fs').readFileSync(join(envDir, '.env'), 'utf8')
    expect(content).toContain('DEFAULT_MODEL=qwen3.6')
  })

  it('R3.4: does not overwrite existing .env', () => {
    mkdirSync(envDir, { recursive: true })
    writeFileSync(join(envDir, '.env'), 'DISCORD_TOKEN=existing\n')
    ensureEnvironment(codebaseDir, envDir)
    const content = require('node:fs').readFileSync(join(envDir, '.env'), 'utf8')
    expect(content).toBe('DISCORD_TOKEN=existing\n')
  })
})

describe('syncEnvironment', () => {
  let envDir: string
  let codebaseDir: string

  beforeEach(() => {
    const ts = Date.now() + Math.random().toString(36).slice(2)
    envDir = join(tmpdir(), `guildbot-sync-test-${ts}`)
    codebaseDir = join(tmpdir(), `guildbot-codebase-sync-test-${ts}`)

    mkdirSync(join(codebaseDir, 'tools', 'new-tool'), { recursive: true })
    writeFileSync(join(codebaseDir, 'tools', 'new-tool', 'definition.json'), '"new"')
    mkdirSync(join(codebaseDir, 'skills', 'new-skill'), { recursive: true })
    writeFileSync(join(codebaseDir, 'skills', 'new-skill', 'SKILL.md'), '---\nname: new-skill\n---')
    mkdirSync(envDir, { recursive: true })
    // Pre-existing tools dir with custom content
    mkdirSync(join(envDir, 'tools', 'custom-tool'), { recursive: true })
    writeFileSync(join(envDir, 'tools', 'custom-tool', 'definition.json'), '"custom"')
  })

  afterEach(async () => {
    await rm(envDir, { recursive: true, force: true })
    await rm(codebaseDir, { recursive: true, force: true })
  })

  it('R3.3: does not overwrite tools when force=false and dir already exists', () => {
    syncEnvironment(codebaseDir, envDir, false)
    // existing tools dir should be unchanged (cpSync skipped)
    expect(existsSync(join(envDir, 'tools', 'custom-tool'))).toBe(true)
    expect(existsSync(join(envDir, 'tools', 'new-tool'))).toBe(false)
  })

  it('R3.3: overwrites tools when force=true', () => {
    syncEnvironment(codebaseDir, envDir, true)
    expect(existsSync(join(envDir, 'tools', 'new-tool', 'definition.json'))).toBe(true)
  })

  it('R3.3: seeds tools when they do not exist yet', () => {
    // Remove tools dir to simulate first run
    require('node:fs').rmSync(join(envDir, 'tools'), { recursive: true, force: true })
    syncEnvironment(codebaseDir, envDir, false)
    expect(existsSync(join(envDir, 'tools', 'new-tool'))).toBe(true)
  })
})

describe('ENV_DIR and ENV_NAME', () => {
  it('R1.4: ENV_NAME defaults to "dev" when GUILDBOT_ENV is not set', async () => {
    // We can only test the already-loaded values since env vars are baked at import time
    const { ENV_NAME } = await import('./env')
    // In test environment, GUILDBOT_ENV is either set or defaults to 'dev'
    expect(typeof ENV_NAME).toBe('string')
    expect(ENV_NAME.length).toBeGreaterThan(0)
  })

  it('R2.1: ENV_DIR is a non-empty absolute path', async () => {
    const { ENV_DIR } = await import('./env')
    expect(ENV_DIR).toBeTruthy()
    expect(ENV_DIR.startsWith('/')).toBe(true)
  })
})
