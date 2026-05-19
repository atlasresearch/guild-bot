import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SKILLS_DIR } from '@guildbot/config'

// R4.3, R6.2: default to the environment's skills dir (seeded from codebase on first run)
const DEFAULT_SKILLS_DIR = SKILLS_DIR

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
export async function discoverSkillDescriptions(skillsDir = DEFAULT_SKILLS_DIR): Promise<SkillMeta[]> {
  const entries = await readdir(skillsDir, { withFileTypes: true })
  const dirs = entries.filter((e) => e.isDirectory())
  const results: SkillMeta[] = []
  for (const d of dirs) {
    try {
      const raw = await readFile(join(skillsDir, d.name, 'SKILL.md'), 'utf-8')
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
export async function loadSkillBody(name: string, skillsDir = DEFAULT_SKILLS_DIR): Promise<string> {
  return readFile(join(skillsDir, name, 'SKILL.md'), 'utf-8')
}
