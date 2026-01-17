import { createSession, extractResponseText, getSession, promptSession } from '@hexafield/agent-workflow'
import appRootPath from 'app-root-path'
import fsp from 'node:fs/promises'
import path from 'node:path'

export type AskQuestionContext = {
  sessionId: string
  sessionDir: string
  sourceId: string
}

export type AttachmentSummary = {
  originalName: string
  storedPath: string
  contentType: string
  size: number
}

const DEFAULT_MODEL = process.env.ASKQUESTION_MODEL || process.env.ASKVIDEO_MODEL || 'github-copilot/gpt-5-mini'
const DEFAULT_UNIVERSE = 'discord'
const DEFAULT_SESSION_DIR = path.resolve(appRootPath.path, '.tmp', `${DEFAULT_UNIVERSE}-sessions`)
const CONTEXT_DIR = path.join(DEFAULT_SESSION_DIR, 'context')

const contextPathFor = (key: string) => path.join(CONTEXT_DIR, `${key}.json`)

/**
 * Ensure a session exists, creating it if necessary.
 * @param sessionId
 * @param sessionDir
 * @param name
 * @returns
 */
export async function ensureSession(sessionId?: string, sessionDir = DEFAULT_SESSION_DIR, name?: string) {
  await fsp.mkdir(sessionDir, { recursive: true })
  if (sessionId) {
    const existing = await getSession(sessionDir, sessionId)
    if (existing) return { ...existing, directory: sessionDir }
  }
  const created = await createSession(sessionDir, name ? { name } : {})
  // Ensure standard folders exist
  await fsp.mkdir(path.join(sessionDir, created.id, 'attachments'), { recursive: true })
  await fsp.mkdir(path.join(sessionDir, created.id, 'output'), { recursive: true })
  return { ...created, directory: sessionDir }
}

/**
 * Save message attachments to session directory.
 * @param sessionDir 
 * @param sessionId 
 * @param messageId 
 * @param attachments 
 * @returns 
 */
export async function saveMessageAttachments(
  sessionDir: string,
  sessionId: string,
  messageId: string,
  attachments: Array<{ url: string; name: string; contentType?: string | null }>
): Promise<AttachmentSummary[]> {
  if (!attachments.length) return []

  const messageDir = path.join(sessionDir, sessionId, 'attachments', messageId)
  await fsp.mkdir(messageDir, { recursive: true })

  const results: AttachmentSummary[] = []

  for (const att of attachments) {
    try {
      const res = await fetch(att.url)
      if (!res.ok) {
        console.warn(`Failed to fetch attachment ${att.url}: ${res.statusText}`)
        continue
      }

      const safeName = att.name.replace(/[^a-zA-Z0-9.-]/g, '_')
      const filePath = path.join(messageDir, safeName)

      const buffer = await res.arrayBuffer()
      await fsp.writeFile(filePath, Buffer.from(buffer))

      const stats = await fsp.stat(filePath)
      console.log(`Saved attachment ${att.name} to ${filePath} (${stats.size} bytes)`)

      results.push({
        originalName: att.name,
        storedPath: filePath,
        contentType: att.contentType || 'application/octet-stream',
        size: stats.size
      })
    } catch (e) {
      console.warn(`Error saving attachment ${att.name}`, e)
    }
  }
  return results
}

export async function formatAttachmentsForPrompt(attachments: AttachmentSummary[]): Promise<string> {
  if (!attachments.length) return ''

  const parts = ['Attachments provided:']
  for (const att of attachments) {
    let extra = ''
    // If it's a text file (and reasonable size), inline it
    const isText =
      att.contentType.startsWith('text/') ||
      ['.txt', '.md', '.json', '.xml', '.yml', '.yaml', '.log', '.csv', '.ts', '.js', '.py'].some((ext) =>
        att.originalName.toLowerCase().endsWith(ext)
      )

    if (isText && att.size < 50 * 1024) {
      // 50KB limit for inlining
      try {
        const content = await fsp.readFile(att.storedPath, 'utf8')
        extra = `\nContent:\n\`\`\`\n${content}\n\`\`\``
      } catch {}
    }

    parts.push(`- File: "${att.originalName}"\n  Path: ${att.storedPath}\n  Type: ${att.contentType}${extra}`)
  }
  return parts.join('\n\n')
}

async function readContext(key: string): Promise<AskQuestionContext | undefined> {
  try {
    const raw = await fsp.readFile(contextPathFor(key), 'utf8')
    return JSON.parse(raw) as AskQuestionContext
  } catch (e: any) {
    if (e?.code === 'ENOENT') return undefined
    throw e
  }
}

async function writeContext(key: string, context: AskQuestionContext) {
  await fsp.mkdir(CONTEXT_DIR, { recursive: true })
  await fsp.writeFile(contextPathFor(key), JSON.stringify(context, null, 2), 'utf8')
}

export async function answerQuestion(options: {
  context: string
  question: string
  sessionId?: string
  sessionDir?: string
  model?: string
  sourceId?: string
}) {
  const model = options.model || DEFAULT_MODEL
  const sessionDir = options.sessionDir || DEFAULT_SESSION_DIR
  const session = await ensureSession(options.sessionId, sessionDir, options.sourceId)
  const prompts = [
    'You answer questions. Respond concisely and avoid speculation. Use only internal reasoning and web search in your answer.',
    `Context:\n${options.context}`,
    `User question: ${options.question}`
  ]
  const response = await promptSession(session, prompts, model)
  const answer = extractResponseText(response.parts ?? (response as any))
  return {
    question: options.question,
    answer,
    sessionId: (session as any).id as string,
    sessionDir,
    parts: response.parts ?? [],
    sourceId: options.sourceId || (session as any).title || 'text'
  }
}

export async function rememberAskQuestionContext(key: string, context: AskQuestionContext) {
  await writeContext(key, context)
}

export async function getAskQuestionContext(key?: string) {
  if (!key) return undefined
  return readContext(key)
}

export async function cloneAskQuestionContext(fromKey: string | undefined, toKey: string | undefined) {
  if (!fromKey || !toKey) return
  const ctx = await readContext(fromKey)
  if (ctx) await writeContext(toKey, ctx)
}

export const ASKQUESTION_CONSTANTS = {
  MODEL: DEFAULT_MODEL,
  UNIVERSE: DEFAULT_UNIVERSE,
  SESSION_DIR: DEFAULT_SESSION_DIR
}
