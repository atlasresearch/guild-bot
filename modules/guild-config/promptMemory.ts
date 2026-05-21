// Per-guild prompt and memory storage (plan 007).
//
// Layout under <GUILD_DIR>:
//   prompt.md, memory.md            — live files (frontmatter + body)
//   history/prompt/<ts>-<reason>.md — append-only history of prior versions
//   history/memory/<ts>-<reason>.md
//   snapshots/<sha256-16>.md        — content-addressed renders for thread injection
//
// All mutating calls route through @guildbot/llm-edit's applyEdits() with a
// minimal validator (non-empty, byte cap, secret denylist) so every write
// path applies the same safety floor. Structure of memory.md is intentionally
// operator-defined — no canonical headings, no ontology.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import fsp from 'node:fs/promises'
import { join } from 'node:path'

import { atomicWrite } from '@guildbot/interfaces'
import { applyEdits } from '@guildbot/llm-edit'

import { loadConfig } from './loadConfig'
import { paths } from './paths'
import {
  parseFrontmatter,
  serializeWithFrontmatter,
  type Frontmatter,
} from './frontmatter'

// ── Types ────────────────────────────────────────────────────────────────────

export type GuildPrompt = {
  /** Raw markdown body (without frontmatter). */
  content: string
  version: number
  updatedAt: string
}

export type GuildMemory = {
  /** Raw markdown body (without frontmatter). */
  content: string
  version: number
  updatedAt: string
  byteSize: number
}

export type UpdateOptions = {
  /** Format: `<source>:<detail>`. See plan 007 § "Reason string format". */
  reason: string
}

// ── Constants ────────────────────────────────────────────────────────────────

// Detect Discord token + a few common API-key shapes. The compactor (plan 008)
// owns the more aggressive denylist; here we just refuse the obviously
// dangerous patterns so an LLM-driven memory write can't immediately leak them.
const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  // Discord bot tokens: 3 base64-ish chunks separated by dots, the first chunk
  // is ≥24 chars. Avoids false-positives on dotted file paths.
  { name: 'discord-token', re: /\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{27,}\b/ },
  // OpenAI / Anthropic style prefixes.
  { name: 'openai-key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
]

// ── Helpers ──────────────────────────────────────────────────────────────────

function timestampSlug(now: Date = new Date()): string {
  // YYYYMMDDTHHmmssSSSZ — collation-safe, no characters that need escaping.
  return now.toISOString().replace(/[-:.]/g, '').replace(/\..+/, 'Z')
}

function reasonSlug(reason: string): string {
  return reason
    .replace(/[^a-zA-Z0-9._:-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80)
    || 'no-reason'
}

function fileMtimeIso(filePath: string): string {
  try {
    return statSync(filePath).mtime.toISOString()
  } catch {
    return new Date().toISOString()
  }
}

async function readFileOrEmpty(filePath: string): Promise<string> {
  try {
    return await fsp.readFile(filePath, 'utf8')
  } catch (e: any) {
    if (e?.code === 'ENOENT') return ''
    throw e
  }
}

// ── Loaders (R2.2: hit disk every call) ─────────────────────────────────────

export async function loadPrompt(): Promise<GuildPrompt> {
  const p = paths()
  const raw = await readFileOrEmpty(p.prompt)
  const parsed = parseFrontmatter(raw, fileMtimeIso(p.prompt))
  return {
    content: parsed.body,
    version: parsed.frontmatter.version,
    updatedAt: parsed.frontmatter.updatedAt,
  }
}

export async function loadMemory(): Promise<GuildMemory> {
  const p = paths()
  const raw = await readFileOrEmpty(p.memory)
  const parsed = parseFrontmatter(raw, fileMtimeIso(p.memory))
  return {
    content: parsed.body,
    version: parsed.frontmatter.version,
    updatedAt: parsed.frontmatter.updatedAt,
    byteSize: Buffer.byteLength(parsed.body, 'utf8'),
  }
}

// ── Validators ──────────────────────────────────────────────────────────────

/**
 * Memory validator: non-empty body, byte cap, and a hardcoded secret-pattern
 * denylist. Structure is intentionally NOT enforced — operators encode whatever
 * organisation makes sense for their guild directly in `memory.md`, and the
 * LLM-driven extractor in plan 008 takes its cues from that file's content.
 */
function validateMemoryBody(body: string, maxBytes: number): void {
  if (!body.trim()) {
    throw new Error('memory.md body must not be empty.')
  }
  if (Buffer.byteLength(body, 'utf8') > maxBytes) {
    throw new Error(`memory.md body exceeds the byte cap (${maxBytes} bytes).`)
  }
  for (const { name, re } of SECRET_PATTERNS) {
    if (re.test(body)) {
      throw new Error(`memory.md may not contain ${name}-shaped secrets.`)
    }
  }
}

function validatePromptBody(body: string, maxBytes: number): void {
  if (!body.trim()) {
    throw new Error('prompt.md body must not be empty.')
  }
  if (Buffer.byteLength(body, 'utf8') > maxBytes) {
    throw new Error(`prompt.md body exceeds the byte cap (${maxBytes} bytes).`)
  }
}

// ── Updaters (R2.5, R7.4) ───────────────────────────────────────────────────

type FileKind = 'prompt' | 'memory'

async function applyAndWrite(
  kind: FileKind,
  newBody: string,
  validate: (body: string) => void,
  reason: string,
): Promise<{ frontmatter: Frontmatter; bodyWritten: string }> {
  const p = paths()
  const livePath = kind === 'prompt' ? p.prompt : p.memory
  const historyDir = kind === 'prompt' ? p.promptHistory : p.memoryHistory
  mkdirSync(historyDir, { recursive: true })

  const previousRaw = await readFileOrEmpty(livePath)
  const previousParsed = parseFrontmatter(previousRaw, fileMtimeIso(livePath))

  // Validate the new body via applyEdits' validator hook — same code path as
  // the LLM-driven edits in plan 006.
  const result = await applyEdits(
    previousParsed.body,
    { kind: 'whole-file', content: newBody },
    { validate: () => validate(newBody) },
  )
  if (!result.success) {
    throw new Error(result.error)
  }

  // Only after the validator passes do we touch history. R2.5: a rejected
  // write produces no history entry.
  if (previousRaw.length > 0) {
    const histPath = join(historyDir, `${timestampSlug()}-${reasonSlug(reason)}.md`)
    await atomicWrite(histPath, previousRaw)
  }

  const nextVersion = previousParsed.frontmatter.version + 1
  const nowIso = new Date().toISOString()
  const fm: Frontmatter = {
    version: nextVersion,
    updatedAt: nowIso,
    extra: previousParsed.frontmatter.extra,
  }
  const serialized = serializeWithFrontmatter(fm, result.newContent)
  await atomicWrite(livePath, serialized)

  return { frontmatter: fm, bodyWritten: result.newContent }
}

export async function updatePrompt(
  content: string,
  opts: UpdateOptions,
): Promise<GuildPrompt> {
  const PROMPT_MAX_BYTES = 64 * 1024
  const { frontmatter, bodyWritten } = await applyAndWrite(
    'prompt',
    content,
    (body) => validatePromptBody(body, PROMPT_MAX_BYTES),
    opts.reason,
  )
  return {
    content: bodyWritten,
    version: frontmatter.version,
    updatedAt: frontmatter.updatedAt,
  }
}

export async function updateMemory(
  content: string,
  opts: UpdateOptions,
): Promise<GuildMemory> {
  const maxBytes = loadConfig().memory.maxBytes
  const { frontmatter, bodyWritten } = await applyAndWrite(
    'memory',
    content,
    (body) => validateMemoryBody(body, maxBytes),
    opts.reason,
  )
  return {
    content: bodyWritten,
    version: frontmatter.version,
    updatedAt: frontmatter.updatedAt,
    byteSize: Buffer.byteLength(bodyWritten, 'utf8'),
  }
}

// ── Rendering (R2.3, R2.4) ──────────────────────────────────────────────────

export type RenderedGuildSystemMessage = {
  content: string
  snapshotPath: string
}

function renderContent(promptBody: string, memoryBody: string): string {
  // Concatenate prompt and memory with exactly two newlines between, trimming
  // both ends of each section so the join never produces 3+ newlines. No
  // bundled section heading — any structure the model should see comes from
  // the operator's own prompt.md / memory.md content.
  const prompt = promptBody.replace(/^\s+|\s+$/g, '')
  const memory = memoryBody.replace(/^\s+|\s+$/g, '')
  return `${prompt}\n\n${memory}\n`
}

export async function renderGuildSystemMessage(): Promise<RenderedGuildSystemMessage> {
  const p = paths()
  const [prompt, memory] = await Promise.all([loadPrompt(), loadMemory()])
  const content = renderContent(prompt.content, memory.content)

  const hash = createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16)
  mkdirSync(p.snapshots, { recursive: true })
  const snapshotPath = join(p.snapshots, `${hash}.md`)

  // R2.4: reuse the existing snapshot if the hash matches — no duplicate writes.
  if (!existsSync(snapshotPath)) {
    await atomicWrite(snapshotPath, content)
  } else {
    // Already exists: do not rewrite. (Defensive: confirm content matches.)
    try {
      const onDisk = readFileSync(snapshotPath, 'utf8')
      if (onDisk !== content) {
        // Hash collision in 16 hex chars (~2^-64) — extremely unlikely, but if
        // it ever happens, fall through and overwrite the stale file so the
        // injected content stays correct.
        await atomicWrite(snapshotPath, content)
      }
    } catch {
      await atomicWrite(snapshotPath, content)
    }
  }

  return { content, snapshotPath }
}

// ── Diffing (R5.4) ──────────────────────────────────────────────────────────

/**
 * Produce a minimal unified diff between `from` and `to`. We don't pull in a
 * diff library — the output is line-by-line with `-`/`+` markers, which is
 * enough for an operator to scan.
 */
export function unifiedDiff(from: string, to: string, fromLabel: string, toLabel: string): string {
  if (from === to) return ''
  const fromLines = from.split('\n')
  const toLines = to.split('\n')
  // Compute LCS-based diff via DP. For our file sizes (≤ a few hundred lines)
  // O(n*m) is fine.
  const m = fromLines.length
  const n = toLines.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (fromLines[i] === toLines[j]) dp[i][j] = dp[i + 1][j + 1] + 1
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out: string[] = [`--- ${fromLabel}`, `+++ ${toLabel}`]
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (fromLines[i] === toLines[j]) {
      out.push(` ${fromLines[i]}`)
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push(`-${fromLines[i]}`)
      i++
    } else {
      out.push(`+${toLines[j]}`)
      j++
    }
  }
  while (i < m) out.push(`-${fromLines[i++]}`)
  while (j < n) out.push(`+${toLines[j++]}`)
  return out.join('\n')
}
