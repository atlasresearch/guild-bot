// Operator-facing helpers for prompt/memory: history listing, revert,
// forget, and diff against the bundled defaults. Shared by the Discord
// slash commands and the CLI subcommands.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import fsp from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { z } from 'zod'

import { paths } from './paths'
import { parseFrontmatter } from './frontmatter'
import {
  CANONICAL_MEMORY_HEADINGS,
  loadMemory,
  loadPrompt,
  unifiedDiff,
  updateMemory,
  updatePrompt,
  type GuildMemory,
  type GuildPrompt,
} from './promptMemory'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_CODEBASE_ROOT = resolve(HERE, '..', '..')

export type HistoryEntry = {
  /** Full filename, e.g. `20260519T182200000Z-operator:12345.md`. */
  filename: string
  /** ISO timestamp parsed from the filename (or empty if unparseable). */
  timestamp: string
  /** Reason slug parsed from the filename. */
  reason: string
  /** Bytes. */
  size: number
}

type Kind = 'prompt' | 'memory'

// ── History listing ─────────────────────────────────────────────────────────

const FILENAME_RE = /^(\d{8}T\d{6}\d{3}Z)-(.+)\.md$/

export function listHistory(kind: Kind): HistoryEntry[] {
  const dir = kind === 'prompt' ? paths().promptHistory : paths().memoryHistory
  if (!existsSync(dir)) return []
  const out: HistoryEntry[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md')) continue
    const m = name.match(FILENAME_RE)
    const ts = m
      ? `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}T` +
        `${m[1].slice(9, 11)}:${m[1].slice(11, 13)}:${m[1].slice(13, 15)}.` +
        `${m[1].slice(15, 18)}Z`
      : ''
    const reason = m ? m[2] : ''
    const size = statSync(join(dir, name)).size
    out.push({ filename: name, timestamp: ts, reason, size })
  }
  // Newest first.
  out.sort((a, b) => b.filename.localeCompare(a.filename))
  return out
}

// ── Revert ──────────────────────────────────────────────────────────────────

/**
 * Revert `prompt.md` or `memory.md` to a prior history entry. The
 * `timestampOrFilename` may be the ISO timestamp segment from the filename
 * (e.g. `20260519T182200000Z`) or the full filename.
 */
export async function revert(
  kind: Kind,
  timestampOrFilename: string,
  reasonDetail: string,
): Promise<GuildPrompt | GuildMemory> {
  const dir = kind === 'prompt' ? paths().promptHistory : paths().memoryHistory
  const entries = listHistory(kind)
  const match = entries.find(
    (e) =>
      e.filename === timestampOrFilename ||
      e.filename.startsWith(`${timestampOrFilename}-`) ||
      e.timestamp === timestampOrFilename,
  )
  if (!match) {
    throw new Error(
      `No ${kind} history entry matched "${timestampOrFilename}". Use 'history' to list entries.`,
    )
  }

  const raw = await fsp.readFile(join(dir, match.filename), 'utf8')
  const fallback = statSync(join(dir, match.filename)).mtime.toISOString()
  const parsed = parseFrontmatter(raw, fallback)
  const reason = `revert:${reasonDetail || match.filename}`

  if (kind === 'prompt') return updatePrompt(parsed.body, { reason })
  return updateMemory(parsed.body, { reason })
}

// ── Diff against bundled default ────────────────────────────────────────────

export function defaultPath(kind: Kind, codebaseRoot?: string): string {
  const root = codebaseRoot ?? DEFAULT_CODEBASE_ROOT
  return join(root, 'guild-defaults', `${kind}.md`)
}

export async function diffAgainstDefault(
  kind: Kind,
  codebaseRoot?: string,
): Promise<string> {
  const defPath = defaultPath(kind, codebaseRoot)
  let defaultContent = ''
  try {
    defaultContent = readFileSync(defPath, 'utf8')
  } catch {
    defaultContent = ''
  }
  const liveRaw =
    kind === 'prompt'
      ? await safeRead(paths().prompt)
      : await safeRead(paths().memory)
  return unifiedDiff(defaultContent, liveRaw, `default/${kind}.md`, `${kind}.md (live)`)
}

async function safeRead(p: string): Promise<string> {
  try {
    return await fsp.readFile(p, 'utf8')
  } catch {
    return ''
  }
}

// ── Forget via structured() ─────────────────────────────────────────────────

const forgetSchema = z.object({
  rewrittenMemory: z
    .string()
    .describe('The full new memory body with matching content removed. Keep the canonical headings.'),
  removed: z
    .array(z.string())
    .describe('The bullets or sentences that were removed, for the audit trail.'),
})

export type ForgetResult = {
  removed: string[]
  before: GuildMemory
  after: GuildMemory
}

/**
 * Rewrite memory.md to remove anything matching the natural-language pattern.
 *
 * The LLM call is injected so tests can stub it.
 */
export async function forgetMemory(
  pattern: string,
  opts: {
    runStructured: (
      prompt: string,
    ) => Promise<{ rewrittenMemory: string; removed: string[] }>
  },
): Promise<ForgetResult> {
  const before = await loadMemory()
  const headingList = CANONICAL_MEMORY_HEADINGS.join(', ')
  const llmPrompt = [
    'You are editing a guild bot\'s long-term memory file. The pattern below describes content the operator wants forgotten.',
    `Pattern: ${pattern}`,
    '',
    'Return the FULL rewritten memory body (no frontmatter) with anything matching the pattern removed.',
    `Preserve the canonical top-level headings exactly: ${headingList}.`,
    'Do not add new headings. Do not invent content. Only remove matching bullets/lines.',
    '',
    'Current memory body:',
    '```',
    before.content,
    '```',
  ].join('\n')

  const result = await opts.runStructured(llmPrompt)

  // applyEdits validator (R1.6 + secret-pattern denylist) runs inside updateMemory.
  const after = await updateMemory(result.rewrittenMemory, {
    reason: `forget:${pattern}`,
  })

  return { removed: result.removed, before, after }
}

export const _forgetSchemaForTests = forgetSchema
