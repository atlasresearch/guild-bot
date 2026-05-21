// R6.10: present, missing, and malformed frontmatter all yield the documented
// defaults.

import { describe, expect, it } from 'vitest'
import { parseFrontmatter, serializeWithFrontmatter } from './frontmatter'

const FALLBACK = '2026-05-21T00:00:00.000Z'

describe('parseFrontmatter', () => {
  it('parses well-formed frontmatter', () => {
    const raw = `---\nversion: 3\nupdatedAt: 2026-05-15T10:00:00.000Z\n---\n\nbody here\n`
    const parsed = parseFrontmatter(raw, FALLBACK)
    expect(parsed.frontmatter.version).toBe(3)
    expect(parsed.frontmatter.updatedAt).toBe('2026-05-15T10:00:00.000Z')
    expect(parsed.body).toBe('\nbody here\n')
  })

  it('treats missing frontmatter as version 0 with fallback updatedAt', () => {
    const raw = `# People\n- Alice\n`
    const parsed = parseFrontmatter(raw, FALLBACK)
    expect(parsed.frontmatter.version).toBe(0)
    expect(parsed.frontmatter.updatedAt).toBe(FALLBACK)
    expect(parsed.body).toBe(raw)
  })

  it('treats malformed frontmatter (bad version) as version 0', () => {
    const raw = `---\nversion: not-a-number\nupdatedAt: also-not-iso\n---\nbody\n`
    const parsed = parseFrontmatter(raw, FALLBACK)
    expect(parsed.frontmatter.version).toBe(0)
    // updatedAt value is taken verbatim if non-empty — we don't validate ISO.
    expect(parsed.frontmatter.updatedAt).toBe('also-not-iso')
    expect(parsed.body).toBe('body\n')
  })

  it('preserves extra frontmatter fields across a round-trip', () => {
    const raw = `---\nname: prompt\nversion: 2\nupdatedAt: 2026-05-15T10:00:00.000Z\n---\nhello\n`
    const parsed = parseFrontmatter(raw, FALLBACK)
    expect(parsed.frontmatter.extra.name).toBe('prompt')
    const out = serializeWithFrontmatter(parsed.frontmatter, parsed.body)
    expect(out).toContain('name: prompt')
    expect(out).toContain('version: 2')
    expect(out).toContain('updatedAt: 2026-05-15T10:00:00.000Z')
    expect(out.endsWith('hello\n')).toBe(true)
  })

  it('strips simple quoting around frontmatter values', () => {
    const raw = `---\nupdatedAt: "2026-05-15T10:00:00.000Z"\nversion: 1\n---\nbody\n`
    const parsed = parseFrontmatter(raw, FALLBACK)
    expect(parsed.frontmatter.updatedAt).toBe('2026-05-15T10:00:00.000Z')
    expect(parsed.frontmatter.version).toBe(1)
  })

  it('falls back to fallback when frontmatter has no updatedAt field', () => {
    const raw = `---\nversion: 5\n---\nbody\n`
    const parsed = parseFrontmatter(raw, FALLBACK)
    expect(parsed.frontmatter.version).toBe(5)
    expect(parsed.frontmatter.updatedAt).toBe(FALLBACK)
  })
})
