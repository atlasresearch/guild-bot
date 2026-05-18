import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Ollama } from 'ollama'
import { z } from 'zod'
import { DEFAULT_MODEL } from '@guildbot/config'
import type { ToolHandler } from '@guildbot/types'
import { verbose } from '@guildbot/interfaces'

export const MeetingDigestSchema = z.object({
  insights: z.array(
    z.object({
      summary: z.string(),
      evidence: z.array(z.string()).optional(),
    })
  ),
  actionItems: z.array(
    z.object({
      task: z.string(),
      owner: z.string().optional(),
      due: z.string().optional(),
      status: z.string().optional(),
      source: z.string().optional(),
    })
  ),
  decisions: z.array(
    z.object({
      decision: z.string(),
      rationale: z.string().optional(),
      source: z.string().optional(),
    })
  ),
  openQuestions: z.array(
    z.object({
      question: z.string(),
      owner: z.string().optional(),
      source: z.string().optional(),
    })
  ),
})

const handler: ToolHandler = async (args, _ctx) => {
  const transcriptLines = args.transcript_lines as string[]
  const prompt = args.prompt as string | undefined
  const systemPrompt = await readFile(join(import.meta.dirname, 'system-prompt.md'), 'utf-8')

  const ollama = new Ollama()
  const content = prompt
    ? `${prompt}\n\nTranscript:\n${transcriptLines.join('\n')}`
    : transcriptLines.join('\n')

  verbose('llm:chat generate-meeting-digest', { model: DEFAULT_MODEL, contentLength: content.length })
  const response = await ollama.chat({
    model: DEFAULT_MODEL,
    format: 'json',
    think: true,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content },
    ],
  } as Parameters<typeof ollama.chat>[0])
  verbose('llm:chat generate-meeting-digest response', response.message.content.slice(0, 200))

  const parsed = JSON.parse(response.message.content)
  const result = MeetingDigestSchema.safeParse(parsed)
  if (!result.success) {
    return { success: false, data: { error: result.error.message } }
  }
  return { success: true, data: result.data }
}

export default handler
