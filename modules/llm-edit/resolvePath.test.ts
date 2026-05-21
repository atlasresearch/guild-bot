import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveAllowedPath } from './resolvePath'

describe('resolveAllowedPath', () => {
  let guildDir: string

  beforeEach(() => {
    guildDir = mkdtempSync(join(tmpdir(), 'resolve-allowed-path-'))
    writeFileSync(join(guildDir, 'prompt.md'), '# default prompt')
    writeFileSync(join(guildDir, 'memory.md'), '# memory')
    writeFileSync(join(guildDir, 'config.json'), '{}')
    writeFileSync(join(guildDir, 'secrets.json'), '{}')
    mkdirSync(join(guildDir, 'snippets'))
    writeFileSync(join(guildDir, 'snippets', 'intro.md'), '# intro')
  })

  afterEach(() => {
    rmSync(guildDir, { recursive: true, force: true })
  })

  it('accepts a path covered by the allowlist', async () => {
    const r = await resolveAllowedPath({
      filePath: 'prompt.md',
      guildDir,
      allowlist: ['prompt.md', 'memory.md'],
    })
    expect(r.ok).toBe(true)
    expect(r.ok && r.relPath).toBe('prompt.md')
  })

  it('accepts a wildcard match', async () => {
    const r = await resolveAllowedPath({
      filePath: 'snippets/intro.md',
      guildDir,
      allowlist: ['snippets/*.md'],
    })
    expect(r.ok).toBe(true)
    expect(r.ok && r.relPath).toBe('snippets/intro.md')
  })

  it('rejects an empty allowlist with the helpful message', async () => {
    const r = await resolveAllowedPath({
      filePath: 'prompt.md',
      guildDir,
      allowlist: [],
    })
    expect(r.ok).toBe(false)
    expect(r.ok || r.error).toMatch(/config\.tools\.editAllowlist is empty/)
  })

  it('rejects a path not covered by the allowlist', async () => {
    const r = await resolveAllowedPath({
      filePath: 'memory.md',
      guildDir,
      allowlist: ['prompt.md'],
    })
    expect(r.ok).toBe(false)
    expect(r.ok || r.error).toMatch(/not-allowlisted/)
  })

  it('rejects absolute file_path', async () => {
    const r = await resolveAllowedPath({
      filePath: '/etc/passwd',
      guildDir,
      allowlist: ['/etc/passwd'],
    })
    expect(r.ok).toBe(false)
    expect(r.ok || r.error).toMatch(/must be relative/)
  })

  it('rejects file_path containing ..', async () => {
    const r = await resolveAllowedPath({
      filePath: '../sibling',
      guildDir,
      allowlist: ['../sibling'],
    })
    expect(r.ok).toBe(false)
    expect(r.ok || r.error).toMatch(/must not contain ".."/)
  })

  it('rejects empty file_path', async () => {
    const r = await resolveAllowedPath({ filePath: '', guildDir, allowlist: ['*'] })
    expect(r.ok).toBe(false)
    expect(r.ok || r.error).toMatch(/required/)
  })

  it('rejects config.json even when allowlisted', async () => {
    const r = await resolveAllowedPath({
      filePath: 'config.json',
      guildDir,
      allowlist: ['*.json'],
    })
    expect(r.ok).toBe(false)
    expect(r.ok || r.error).toMatch(/sensitive-file-denied/)
    expect(r.ok || r.error).toMatch(/config\.json/)
  })

  it('rejects secrets.json even when allowlisted', async () => {
    const r = await resolveAllowedPath({
      filePath: 'secrets.json',
      guildDir,
      allowlist: ['secrets.json'],
    })
    expect(r.ok).toBe(false)
    expect(r.ok || r.error).toMatch(/sensitive-file-denied/)
  })

  it('rejects a symlink that escapes the guild dir', async () => {
    // Create a sibling dir outside guildDir, symlink one of its files inside.
    const sibling = mkdtempSync(join(tmpdir(), 'resolve-allowed-path-outside-'))
    try {
      writeFileSync(join(sibling, 'secret.md'), 'pwned')
      symlinkSync(join(sibling, 'secret.md'), join(guildDir, 'escape.md'))
      const r = await resolveAllowedPath({
        filePath: 'escape.md',
        guildDir,
        allowlist: ['escape.md'],
      })
      expect(r.ok).toBe(false)
      expect(r.ok || r.error).toMatch(/escapes the guild dir/)
    } finally {
      rmSync(sibling, { recursive: true, force: true })
    }
  })

  it('accepts a file that does not yet exist but whose parent does', async () => {
    const r = await resolveAllowedPath({
      filePath: 'snippets/new.md',
      guildDir,
      allowlist: ['snippets/*.md'],
    })
    expect(r.ok).toBe(true)
  })

  it('rejects a path whose parent directory does not exist', async () => {
    const r = await resolveAllowedPath({
      filePath: 'never/created/file.md',
      guildDir,
      allowlist: ['*'],
    })
    expect(r.ok).toBe(false)
    expect(r.ok || r.error).toMatch(/Parent directory of "never\/created\/file\.md" does not exist|not-allowlisted/)
  })
})
