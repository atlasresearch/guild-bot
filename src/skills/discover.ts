import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { paths } from '@guildbot/guild-config'

export type SkillMeta = { name: string; description: string }

// Parse YAML frontmatter from a SKILL.md string
export function parseFrontmatter(raw: string): Record<string, string> {
  const match = raw.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return {}
  const fm: Record<string, string> = {}
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':')
    if (colon === -1) continue
    const key = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).trim().replace(/^['"]|['"]$/g, '')
    fm[key] = value
  }
  return fm
}

// Read frontmatter from all skills/<name>/SKILL.md — called per request, no cache
export async function discoverSkillDescriptions(skillsDir?: string): Promise<SkillMeta[]> {
  const dir = skillsDir ?? paths().skills
  const entries = await readdir(dir, { withFileTypes: true })
  const dirs = entries.filter((e) => e.isDirectory())
  const results: SkillMeta[] = []
  for (const d of dirs) {
    try {
      const raw = await readFile(join(dir, d.name, 'SKILL.md'), 'utf-8')
      const fm = parseFrontmatter(raw)
      if (fm.name && fm.description) {
        results.push({ name: fm.name, description: fm.description })
      }
    } catch {
      // R6.6: silently skip directories that lack a SKILL.md
    }
  }
  return results
}

// Load full SKILL.md body + references for a specific skill — on demand
export async function loadSkillBody(name: string, skillsDir?: string): Promise<string> {
  const dir = skillsDir ?? paths().skills
  return readFile(join(dir, name, 'SKILL.md'), 'utf-8')
}
