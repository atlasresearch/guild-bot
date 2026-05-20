import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { structured } from '@guildbot/llm'
import type { ToolHandler } from '@guildbot/types'

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

  const userContent = prompt
    ? `${prompt}\n\nTranscript:\n${transcriptLines.join('\n')}`
    : transcriptLines.join('\n')

  const result = await structured({
    schema: MeetingDigestSchema,
    schemaName: 'meeting_digest',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    thinking: true,
  })

  if (!result.success) {
    return { success: false, data: { error: result.error } }
  }
  return { success: true, data: result.data }
}

export default handler
