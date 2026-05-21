import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConfigError, loadConfig } from './loadConfig'

const VALID_CONFIG = {
  version: 1,
  guild: { id: 'discord:test-guild', name: 'test' },
  discord: { token: { $secret: 'discord.token' } },
  llm: {
    provider: 'ollama',
    baseUrl: 'http://localhost:11434/v1',
    models: { default: 'qwen3.6', embed: 'nomic-embed-text' },
    embed: {},
  },
  recording: {},
  threads: { compaction: { thresholdMessages: 60, thresholdTokens: 20000, keepLastN: 10 } },
  memory: { maxBytes: 32000, extractionEnabled: true, operatorRoleIds: [] },
  tools: { disabled: [] },
}

function writeConfig(guildDir: string, config: unknown): void {
  writeFileSync(join(guildDir, 'config.json'), JSON.stringify(config, null, 2), 'utf8')
}

function writeSecrets(guildDir: string, secrets: Record<string, string>, mode = 0o600): void {
  const p = join(guildDir, 'secrets.json')
  writeFileSync(p, JSON.stringify(secrets, null, 2), 'utf8')
  chmodSync(p, mode)
}

describe('loadConfig', () => {
  let guildDir: string

  beforeEach(() => {
    guildDir = mkdtempSync(join(tmpdir(), 'guildbot-loadconfig-test-'))
  })
  afterEach(() => {
    rmSync(guildDir, { recursive: true, force: true })
  })

  // +: schema validation
  it('rejects config.json with unknown version', () => {
    writeConfig(guildDir, { ...VALID_CONFIG, version: 2 })
    writeSecrets(guildDir, { 'discord.token': 'fake' })
    expect(() => loadConfig(guildDir)).toThrow(ConfigError)
  })

  it('rejects config.json with missing required field', () => {
    const bad = { ...VALID_CONFIG, guild: { name: 'missing id' } }
    writeConfig(guildDir, bad)
    writeSecrets(guildDir, { 'discord.token': 'fake' })
    expect(() => loadConfig(guildDir)).toThrowError(/guild\.id/)
  })

  it('rejects unknown top-level fields (strict schema)', () => {
    writeConfig(guildDir, { ...VALID_CONFIG, extraneous: true })
    writeSecrets(guildDir, { 'discord.token': 'fake' })
    expect(() => loadConfig(guildDir)).toThrow(ConfigError)
  })

  // no caching
  it('re-reads config.json on every call (observes edits)', () => {
    writeConfig(guildDir, VALID_CONFIG)
    writeSecrets(guildDir, { 'discord.token': 'fake' })
    const first = loadConfig(guildDir)
    expect(first.llm.models.default).toBe('qwen3.6')

    writeConfig(guildDir, {
      ...VALID_CONFIG,
      llm: { ...VALID_CONFIG.llm, models: { default: 'edited-model', embed: 'nomic-embed-text' } },
    })
    const second = loadConfig(guildDir)
    expect(second.llm.models.default).toBe('edited-model')
  })

  it('re-reads secrets.json on every call', () => {
    writeConfig(guildDir, VALID_CONFIG)
    writeSecrets(guildDir, { 'discord.token': 'token-one' })
    expect(loadConfig(guildDir).discord.token).toBe('token-one')

    writeSecrets(guildDir, { 'discord.token': 'token-two' })
    expect(loadConfig(guildDir).discord.token).toBe('token-two')
  })

  // returned object is frozen
  it('returns a deeply frozen config', () => {
    writeConfig(guildDir, VALID_CONFIG)
    writeSecrets(guildDir, { 'discord.token': 'fake' })
    const cfg = loadConfig(guildDir)
    expect(Object.isFrozen(cfg)).toBe(true)
    expect(Object.isFrozen(cfg.llm)).toBe(true)
    expect(Object.isFrozen(cfg.llm.models)).toBe(true)
    expect(() => {
      ;(cfg as unknown as { llm: { provider: string } }).llm.provider = 'anthropic'
    }).toThrow()
  })

  // inline secrets rejected
  it('rejects an inline-string discord.token', () => {
    const bad = { ...VALID_CONFIG, discord: { token: 'inline-bot-token-XXX' } }
    writeConfig(guildDir, bad)
    writeSecrets(guildDir, { 'discord.token': 'fake' })
    expect(() => loadConfig(guildDir)).toThrowError(/inline string secrets are not permitted/)
  })

  it('rejects an inline-string llm.apiKey', () => {
    const bad = { ...VALID_CONFIG, llm: { ...VALID_CONFIG.llm, apiKey: 'sk-xxxxxx' } }
    writeConfig(guildDir, bad)
    writeSecrets(guildDir, { 'discord.token': 'fake' })
    expect(() => loadConfig(guildDir)).toThrowError(/inline string secrets are not permitted/)
  })

  // permission check
  it('refuses to start when secrets.json is mode 0644', () => {
    writeConfig(guildDir, VALID_CONFIG)
    writeSecrets(guildDir, { 'discord.token': 'fake' }, 0o644)
    expect(() => loadConfig(guildDir)).toThrowError(/unsafe permissions/)
  })

  // secret resolution
  it('resolves $secret references against secrets.json', () => {
    writeConfig(guildDir, VALID_CONFIG)
    writeSecrets(guildDir, { 'discord.token': 'resolved-bot-token' })
    const cfg = loadConfig(guildDir)
    expect(cfg.discord.token).toBe('resolved-bot-token')
  })

  it('throws a clear error when a referenced secret is missing', () => {
    writeConfig(guildDir, VALID_CONFIG)
    writeSecrets(guildDir, {})
    expect(() => loadConfig(guildDir)).toThrowError(/missing secret "discord\.token"/)
  })

  // reserved prefixes
  it('rejects $env references with a "not yet supported" error', () => {
    const bad = { ...VALID_CONFIG, discord: { token: { $env: 'DISCORD_TOKEN' } } }
    writeConfig(guildDir, bad)
    writeSecrets(guildDir, { 'discord.token': 'fake' })
    expect(() => loadConfig(guildDir)).toThrowError(/\$env references are not yet supported/)
  })

  it('rejects $file references with a "not yet supported" error', () => {
    const bad = { ...VALID_CONFIG, llm: { ...VALID_CONFIG.llm, apiKey: { $file: 'secrets/key' } } }
    writeConfig(guildDir, bad)
    writeSecrets(guildDir, { 'discord.token': 'fake' })
    expect(() => loadConfig(guildDir)).toThrowError(/\$file references are not yet supported/)
  })

  // secrets.json structure
  it('rejects nested objects in secrets.json', () => {
    writeConfig(guildDir, VALID_CONFIG)
    const p = join(guildDir, 'secrets.json')
    writeFileSync(p, JSON.stringify({ 'discord.token': { nested: 'value' } }), 'utf8')
    chmodSync(p, 0o600)
    expect(() => loadConfig(guildDir)).toThrowError(/must be a string|flat object/)
  })

  // Missing files
  it('produces a clear error when config.json is missing', () => {
    writeSecrets(guildDir, { 'discord.token': 'fake' })
    expect(() => loadConfig(guildDir)).toThrowError(/config\.json not found/)
  })

  it('produces a clear error when secrets.json is missing', () => {
    writeConfig(guildDir, VALID_CONFIG)
    expect(() => loadConfig(guildDir)).toThrowError(/secrets\.json not found/)
  })

  // editAllowlist (plan 006)
  it('defaults tools.editAllowlist to an empty array when omitted', () => {
    writeConfig(guildDir, VALID_CONFIG) // no tools.editAllowlist
    writeSecrets(guildDir, { 'discord.token': 'fake' })
    const cfg = loadConfig(guildDir)
    expect(cfg.tools.editAllowlist).toEqual([])
  })

  it('accepts a valid editAllowlist with exact paths and single-segment wildcards', () => {
    writeConfig(guildDir, {
      ...VALID_CONFIG,
      tools: { disabled: [], editAllowlist: ['prompt.md', 'memory.md', 'snippets/*.md'] },
    })
    writeSecrets(guildDir, { 'discord.token': 'fake' })
    const cfg = loadConfig(guildDir)
    expect(cfg.tools.editAllowlist).toEqual(['prompt.md', 'memory.md', 'snippets/*.md'])
  })

  it('rejects an editAllowlist entry that starts with /', () => {
    writeConfig(guildDir, {
      ...VALID_CONFIG,
      tools: { disabled: [], editAllowlist: ['/etc/passwd'] },
    })
    writeSecrets(guildDir, { 'discord.token': 'fake' })
    expect(() => loadConfig(guildDir)).toThrowError(/must be relative paths/)
  })

  it('rejects an editAllowlist entry containing ..', () => {
    writeConfig(guildDir, {
      ...VALID_CONFIG,
      tools: { disabled: [], editAllowlist: ['../sibling/file.md'] },
    })
    writeSecrets(guildDir, { 'discord.token': 'fake' })
    expect(() => loadConfig(guildDir)).toThrowError(/must not contain ".."/)
  })

  it('rejects an editAllowlist entry using **', () => {
    writeConfig(guildDir, {
      ...VALID_CONFIG,
      tools: { disabled: [], editAllowlist: ['**/foo.md'] },
    })
    writeSecrets(guildDir, { 'discord.token': 'fake' })
    expect(() => loadConfig(guildDir)).toThrowError(/recursive globs/)
  })

  it('rejects an editAllowlist entry using character classes', () => {
    writeConfig(guildDir, {
      ...VALID_CONFIG,
      tools: { disabled: [], editAllowlist: ['[abc].md'] },
    })
    writeSecrets(guildDir, { 'discord.token': 'fake' })
    expect(() => loadConfig(guildDir)).toThrowError(/character classes/)
  })

  it('rejects an editAllowlist entry using brace expansion', () => {
    writeConfig(guildDir, {
      ...VALID_CONFIG,
      tools: { disabled: [], editAllowlist: ['{a,b}.md'] },
    })
    writeSecrets(guildDir, { 'discord.token': 'fake' })
    expect(() => loadConfig(guildDir)).toThrowError(/brace expansion/)
  })

  // Happy path
  it('returns a fully resolved config with $secret values substituted', () => {
    writeConfig(guildDir, {
      ...VALID_CONFIG,
      llm: {
        ...VALID_CONFIG.llm,
        apiKey: { $secret: 'llm.apiKey' },
      },
    })
    writeSecrets(guildDir, { 'discord.token': 'token-A', 'llm.apiKey': 'key-B' })
    const cfg = loadConfig(guildDir)
    expect(cfg.discord.token).toBe('token-A')
    expect(cfg.llm.apiKey).toBe('key-B')
    expect(cfg.guild.id).toBe('discord:test-guild')
  })
})
