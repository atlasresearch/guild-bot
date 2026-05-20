import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { structured } from '@guildbot/llm'
import type { ToolHandler } from '@guildbot/types'

const CldNodeSchema = z.object({
  label: z.string(),
  type: z.enum(['driver', 'obstacle', 'actor', 'other']),
})

const CldRelationshipSchema = z.object({
  subject: z.string(),
  object: z.string(),
  predicate: z.enum(['positive', 'negative']),
  reasoning: z.string(),
  relevant: z.array(z.string()),
  createdAt: z.string(),
})

export const CldOutputSchema = z.object({
  nodes: z.array(CldNodeSchema),
  relationships: z.array(CldRelationshipSchema),
})

const handler: ToolHandler = async (args, _ctx) => {
  const text = args.text as string
  const prompt = args.prompt as string | undefined
  const systemPrompt = await readFile(join(import.meta.dirname, 'system-prompt.md'), 'utf-8')

  const userContent = prompt ? `${prompt}\n\nSource text:\n${text}` : text

  const result = await structured({
    schema: CldOutputSchema,
    schemaName: 'causal_relationships',
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
