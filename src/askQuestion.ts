import { randomUUID } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { loadConfig, paths } from '@guildbot/guild-config'
import { verbose } from '@guildbot/interfaces'
import ollama from 'ollama'

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

// Sessions and context dir come from @guildbot/guild-config. Resolved per call
// so edits to the active guild dir take effect without restart.
const contextPathFor = (key: string) => path.join(paths().contextDir, `${key}.json`)

type SessionMeta = { id: string; title?: string; createdAt: string }

async function readSessionMeta(sessionDir: string, sessionId: string): Promise<SessionMeta | undefined> {
  try {
    const raw = await fsp.readFile(path.join(sessionDir, sessionId, 'meta.json'), 'utf8')
    return JSON.parse(raw) as SessionMeta
  } catch {
    return undefined
  }
}

async function writeSessionMeta(sessionDir: string, meta: SessionMeta) {
  const dir = path.join(sessionDir, meta.id)
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8')
}

/**
 * Ensure a session exists, creating it if necessary.
 */
export async function ensureSession(sessionId?: string, sessionDir?: string, name?: string) {
  sessionDir = sessionDir ?? paths().sessions
  await fsp.mkdir(sessionDir, { recursive: true })
  if (sessionId) {
    const existing = await readSessionMeta(sessionDir, sessionId)
    if (existing) return { ...existing, directory: sessionDir }
  }
  const id = randomUUID()
  const meta: SessionMeta = { id, title: name, createdAt: new Date().toISOString() }
  await writeSessionMeta(sessionDir, meta)
  await fsp.mkdir(path.join(sessionDir, id, 'attachments'), { recursive: true })
  await fsp.mkdir(path.join(sessionDir, id, 'output'), { recursive: true })
  return { ...meta, directory: sessionDir }
}

/**
 * Save message attachments to session directory.
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
    const isText =
      att.contentType.startsWith('text/') ||
      ['.txt', '.md', '.json', '.xml', '.yml', '.yaml', '.log', '.csv', '.ts', '.js', '.py'].some((ext) =>
        att.originalName.toLowerCase().endsWith(ext)
      )

    if (isText && att.size < 50 * 1024) {
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
  await fsp.mkdir(paths().contextDir, { recursive: true })
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
  const cfg = loadConfig()
  const model = options.model || cfg.llm.models.default
  const sessionDir = options.sessionDir || paths().sessions
  const session = await ensureSession(options.sessionId, sessionDir, options.sourceId)

  verbose('llm:chat answerQuestion', { model, sessionId: session })
  const response = await ollama.chat({
    model,
    messages: [
      {
        role: 'system',
        content:
          'You answer questions. Respond concisely and avoid speculation. Use only internal reasoning and web search in your answer.'
      },
      { role: 'user', content: `Context:\n${options.context}\n\nUser question: ${options.question}` }
    ]
  })
  verbose('llm:chat answerQuestion response', response.message?.content?.slice(0, 200))

  const answer = response.message?.content ?? ''
  return {
    question: options.question,
    answer,
    sessionId: (session as any).id as string,
    sessionDir,
    parts: [answer],
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

