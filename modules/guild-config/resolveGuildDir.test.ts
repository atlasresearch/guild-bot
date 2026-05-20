import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  GuildDirNotFoundError,
  parseGuildDirArg,
  resolveGuildDir,
  resolveGuildDirOrThrow,
} from './resolveGuildDir'

describe('parseGuildDirArg', () => {
  it('parses --guild-dir <path> split form', () => {
    expect(parseGuildDirArg(['--guild-dir', '/tmp/foo'])).toBe('/tmp/foo')
  })
  it('parses --guild-dir=<path> single-token form', () => {
    expect(parseGuildDirArg(['--guild-dir=/tmp/bar'])).toBe('/tmp/bar')
  })
  it('returns undefined when not present', () => {
    expect(parseGuildDirArg(['some', 'other', 'args'])).toBeUndefined()
  })
})

describe('resolveGuildDir', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    delete process.env.GUILDBOT_GUILD_DIR
    delete process.env.GUILDBOT_ENV
  })
  afterEach(() => {
    for (const k of Object.keys(process.env)) delete process.env[k]
    Object.assign(process.env, originalEnv)
  })

  // R3.1, R3.2: precedence
  it('R3.1: --guild-dir wins over GUILDBOT_GUILD_DIR', () => {
    process.env.GUILDBOT_GUILD_DIR = '/from-env'
    expect(resolveGuildDir(['--guild-dir', '/from-cli'])).toBe(resolve('/from-cli'))
  })

  it('R3.1: default is ~/.guildbot/default/', () => {
    expect(resolveGuildDir([])).toBe(resolve(join(homedir(), '.guildbot', 'default')))
  })

  // R3.3: canonicalisation
  it('R3.3: returns an absolute, canonical path', () => {
    process.env.GUILDBOT_GUILD_DIR = './relative'
    const r = resolveGuildDir([])
    expect(r.startsWith('/')).toBe(true)
  })
})

describe('resolveGuildDirOrThrow', () => {
  const originalEnv = { ...process.env }
  let realDir: string

  beforeEach(() => {
    delete process.env.GUILDBOT_GUILD_DIR
    delete process.env.GUILDBOT_ENV
    realDir = mkdtempSync(join(tmpdir(), 'guildbot-resolve-test-'))
  })
  afterEach(() => {
    rmSync(realDir, { recursive: true, force: true })
    for (const k of Object.keys(process.env)) delete process.env[k]
    Object.assign(process.env, originalEnv)
  })

  it('R3.4: returns the dir when it exists', () => {
    process.env.GUILDBOT_GUILD_DIR = realDir
    expect(resolveGuildDirOrThrow([])).toBe(resolve(realDir))
  })

  it('R3.4: throws GuildDirNotFoundError with a guildbot init hint when missing', () => {
    process.env.GUILDBOT_GUILD_DIR = '/nonexistent/guild-dir-xyz'
    expect(() => resolveGuildDirOrThrow([])).toThrow(GuildDirNotFoundError)
    try {
      resolveGuildDirOrThrow([])
    } catch (e) {
      expect((e as Error).message).toMatch(/guildbot init/)
    }
  })
})
