import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Ollama } from 'ollama'
import { z } from 'zod'
import { loadConfig } from '@guildbot/guild-config'
import type { ToolHandler } from '@guildbot/types'
import { verbose } from '@guildbot/interfaces'

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

  const ollama = new Ollama()
  const model = loadConfig().llm.models.default
  verbose('llm:chat extract-causal-relationships', { model, textLength: text.length })
  const response = await ollama.chat({
    model,
    format: 'json',
    think: true,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: prompt ? `${prompt}\n\nSource text:\n${text}` : text,
      },
    ],
  } as Parameters<typeof ollama.chat>[0])
  verbose('llm:chat extract-causal-relationships response', response.message.content.slice(0, 200))

  const parsed = JSON.parse(response.message.content)
  const result = CldOutputSchema.safeParse(parsed)
  if (!result.success) {
    return { success: false, data: { error: result.error.message } }
  }
  return { success: true, data: result.data }
}

export default handler
