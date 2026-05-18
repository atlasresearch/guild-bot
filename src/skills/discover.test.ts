import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { discoverSkillDescriptions, loadSkillBody } from './discover'

// Tests exercise real discovery functions against fixture directories on disk.
// No mocking of internal modules (R7.9).

describe('discoverSkillDescriptions', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'skills-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('should extract name and description from SKILL.md frontmatter', async () => {
    await mkdir(join(tempDir, 'test-skill'))
    await writeFile(
      join(tempDir, 'test-skill', 'SKILL.md'),
      `---
name: test-skill
description: 'A test skill for unit testing.'
---

# Test Skill

## When to Use
- During tests
`
    )

    const skills = await discoverSkillDescriptions(tempDir)
    expect(skills).toHaveLength(1)
    expect(skills[0].name).toBe('test-skill')
    expect(skills[0].description).toBe('A test skill for unit testing.')
  })

  it('should discover multiple skills from subdirectories', async () => {
    await mkdir(join(tempDir, 'skill-a'))
    await writeFile(
      join(tempDir, 'skill-a', 'SKILL.md'),
      `---\nname: skill-a\ndescription: 'First skill'\n---\n# A`
    )
    await mkdir(join(tempDir, 'skill-b'))
    await writeFile(
      join(tempDir, 'skill-b', 'SKILL.md'),
      `---\nname: skill-b\ndescription: 'Second skill'\n---\n# B`
    )

    const skills = await discoverSkillDescriptions(tempDir)
    expect(skills).toHaveLength(2)
    const names = skills.map((s) => s.name).sort()
    expect(names).toEqual(['skill-a', 'skill-b'])
  })

  it('should silently skip directories without SKILL.md', async () => {
    await mkdir(join(tempDir, 'has-skill'))
    await writeFile(
      join(tempDir, 'has-skill', 'SKILL.md'),
      `---\nname: has-skill\ndescription: 'Present'\n---\n# Present`
    )
    await mkdir(join(tempDir, 'no-skill'))

    const skills = await discoverSkillDescriptions(tempDir)
    expect(skills).toHaveLength(1)
    expect(skills[0].name).toBe('has-skill')
  })
})

describe('loadSkillBody', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'skills-body-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('should return full SKILL.md content for a named skill', async () => {
    const content = `---\nname: test\ndescription: 'Test'\n---\n# Full Body`
    await mkdir(join(tempDir, 'test'))
    await writeFile(join(tempDir, 'test', 'SKILL.md'), content)

    const body = await loadSkillBody('test', tempDir)
    expect(body).toBe(content)
  })

  it('should throw if the skill does not exist', async () => {
    await expect(loadSkillBody('nonexistent', tempDir)).rejects.toThrow()
  })
})
