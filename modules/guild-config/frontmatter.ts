// Minimal in-house frontmatter parser/serializer for prompt.md and memory.md.
//
// Per plan 007 R2.6: only `version: number` and `updatedAt: string` are
// honoured. Missing or malformed frontmatter yields { version: 0,
// updatedAt: <fallback> } so a hand-edited file without frontmatter still
// loads cleanly. No external gray-matter dependency, consistent with plan
// 006's "own your foundations" pattern.
//
// The accepted shape is conservative:
//   ---
//   key: value
//   key2: value2
//   ---
//   <body>
//
// Quoting is permitted but not required. Anything we don't recognise in the
// frontmatter is preserved (passed through serialize) so additional metadata
// like `name:` survives a round-trip.

export type Frontmatter = {
  version: number
  updatedAt: string
  /** Any frontmatter fields not consumed by us, preserved across writes. */
  extra: Record<string, string>
}

export type ParsedFile = {
  frontmatter: Frontmatter
  /** The body, with the frontmatter block stripped. Leading blank lines preserved. */
  body: string
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

/**
 * Parse a markdown file with optional frontmatter.
 *
 * @param raw  The raw file content.
 * @param fallbackUpdatedAt  Used when frontmatter is missing or `updatedAt` is
 *                           absent. Pass the file mtime as ISO string.
 */
export function parseFrontmatter(raw: string, fallbackUpdatedAt: string): ParsedFile {
  const m = raw.match(FRONTMATTER_RE)
  if (!m) {
    return {
      frontmatter: { version: 0, updatedAt: fallbackUpdatedAt, extra: {} },
      body: raw,
    }
  }

  const yamlBlock = m[1]
  const body = raw.slice(m[0].length)

  let version: number = 0
  let updatedAt: string = fallbackUpdatedAt
  const extra: Record<string, string> = {}

  for (const line of yamlBlock.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const colon = trimmed.indexOf(':')
    if (colon <= 0) continue
    const key = trimmed.slice(0, colon).trim()
    let value = trimmed.slice(colon + 1).trim()
    // Strip simple quotes if balanced.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }

    if (key === 'version') {
      const n = Number(value)
      version = Number.isFinite(n) ? Math.trunc(n) : 0
    } else if (key === 'updatedAt') {
      updatedAt = value || fallbackUpdatedAt
    } else {
      extra[key] = value
    }
  }

  return { frontmatter: { version, updatedAt, extra }, body }
}

/**
 * Re-emit a file with frontmatter. The body is preserved verbatim — callers
 * pass in the body they intend to write.
 */
export function serializeWithFrontmatter(fm: Frontmatter, body: string): string {
  const lines: string[] = ['---']
  // Preserve any extra keys first so they round-trip in file order.
  for (const [k, v] of Object.entries(fm.extra ?? {})) {
    lines.push(`${k}: ${v}`)
  }
  lines.push(`version: ${fm.version}`)
  lines.push(`updatedAt: ${fm.updatedAt}`)
  lines.push('---')
  lines.push('')
  return lines.join('\n') + body
}
