import { atomicWrite } from '@guildbot/interfaces'
import fsp from 'node:fs/promises'
import path from 'node:path'

export type LinkKind = 'content' | 'embed' | 'attachment'

export interface ExtractedLink {
  url: string
  kind: LinkKind
}

/** The parts of a Discord message that can carry links. */
export interface LinkSource {
  content?: string | null
  embeds?: Iterable<{ url?: string | null }>
  /** A list, or a discord.js Collection (a Map keyed by attachment id), as a Message carries them. */
  attachments?: Iterable<{ url?: string | null }> | ReadonlyMap<string, { url?: string | null }>
}

export interface LinkRow {
  url: string
  kind: LinkKind
  guildId: string
  channelId: string
  channelName: string
  parentChannelName: string
  messageId: string
  messageUrl: string
  authorId: string
  authorName: string
  timestamp: string
}

export const LINK_COLUMNS: readonly (keyof LinkRow)[] = [
  'url',
  'kind',
  'guildId',
  'channelId',
  'channelName',
  'parentChannelName',
  'messageId',
  'messageUrl',
  'authorId',
  'authorName',
  'timestamp'
]

// Whitespace, angle brackets, quotes and backticks never belong to a URL in chat text.
const URL_PATTERN = /https?:\/\/[^\s<>"`]+/gi
// Punctuation that usually ends a sentence or markdown span rather than the URL.
const TRAILING_PUNCTUATION = /[.,;:!?'*~|]+$/
const PAIRS: Record<string, string> = { ')': '(', ']': '[' }

/** Cut the URL at the first closing bracket that has no matching opener inside the URL. */
function cutUnbalanced(url: string): string {
  const depth: Record<string, number> = { '(': 0, '[': 0 }
  for (let i = 0; i < url.length; i++) {
    const c = url[i]
    if (c === '(' || c === '[') depth[c]++
    else if (c in PAIRS) {
      const open = PAIRS[c]
      if (depth[open] === 0) return url.slice(0, i)
      depth[open]--
    }
  }
  return url
}

function trimUrl(raw: string): string {
  let url = raw
  let prev = ''
  while (url !== prev) {
    prev = url
    url = cutUnbalanced(url).replace(TRAILING_PUNCTUATION, '')
  }
  return url
}

/** Every http(s) URL in free text, in order of appearance. Handles `<url>` and `[text](url)`. */
export function extractUrlsFromText(text: string): string[] {
  const urls: string[] = []
  const re = new RegExp(URL_PATTERN.source, URL_PATTERN.flags)
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const url = trimUrl(m[0])
    // Resume right after the kept part so a URL glued on by markdown (`[a](b)`) is still found.
    re.lastIndex = m.index + Math.max(url.length, 1)
    if (/^https?:\/\/[^/?#]+/i.test(url)) urls.push(url)
  }
  return urls
}

/** Links in a message's content, embeds and attachments. Exact repeats of a URL keep only the first. */
export function extractLinks(source: LinkSource): ExtractedLink[] {
  const found: ExtractedLink[] = []
  for (const url of extractUrlsFromText(source.content ?? '')) found.push({ url, kind: 'content' })
  for (const e of source.embeds ?? []) if (e.url) found.push({ url: e.url, kind: 'embed' })
  const attachments = source.attachments instanceof Map ? source.attachments.values() : (source.attachments ?? [])
  for (const a of attachments as Iterable<{ url?: string | null }>)
    if (a.url) found.push({ url: a.url, kind: 'attachment' })

  const seen = new Set<string>()
  return found.filter((l) => {
    if (seen.has(l.url)) return false
    seen.add(l.url)
    return true
  })
}

function compareSnowflakes(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length
  return a < b ? -1 : a > b ? 1 : 0
}

/** Oldest first. Rows of one message keep their extraction order. */
export function sortLinkRows(rows: LinkRow[]): LinkRow[] {
  return [...rows].sort(
    (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || compareSnowflakes(a.messageId, b.messageId)
  )
}

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

export function linksToCSV(rows: LinkRow[]): string {
  const lines = [LINK_COLUMNS.join(',')]
  for (const row of sortLinkRows(rows)) lines.push(LINK_COLUMNS.map((c) => csvField(row[c])).join(','))
  return lines.join('\r\n') + '\r\n'
}

export function linksToJSON(rows: LinkRow[]): string {
  const ordered = sortLinkRows(rows).map((row) => Object.fromEntries(LINK_COLUMNS.map((c) => [c, row[c]])))
  return JSON.stringify(ordered, null, 2) + '\n'
}

/** `.json` writes a JSON array; any other extension writes CSV. */
export function formatLinks(rows: LinkRow[], outPath: string): string {
  return path.extname(outPath).toLowerCase() === '.json' ? linksToJSON(rows) : linksToCSV(rows)
}

export async function writeLinks(rows: LinkRow[], outPath: string): Promise<void> {
  await fsp.mkdir(path.dirname(outPath), { recursive: true })
  await atomicWrite(outPath, formatLinks(rows, outPath))
}
