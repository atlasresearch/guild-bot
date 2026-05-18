// src/services/rag.ts
import ollama from 'ollama'
import * as db from '@guildbot/database'
import { DEFAULT_MODEL } from '@guildbot/config'
import { getEmbedding } from '@guildbot/embedding'
import { verbose } from '@guildbot/interfaces'

export const search = async (guildId: string, query: string, limit: number = 5) => {
  const queryVector = await getEmbedding(query)
  const filter = `guild_id = '${guildId}'`

  const results = await db.searchVector(queryVector, limit, filter)
  return results
}

export const ask = async (guildId: string, question: string, model: string = DEFAULT_MODEL) => {
  const results = await search(guildId, question, 10)

  let context = 'Here are some relevant messages from the history:\n'
  results.forEach((r: any) => {
    context += `[${new Date(r.timestamp).toISOString()}] ${r.user_id}: ${r.content}\n`
  })

  const prompt = `Context:\n${context}\n\nQuestion: ${question}\n\nAnswer the question based on the context provided.`

  verbose('llm:generate rag.ask', { model, promptLength: prompt.length })
  const response = await ollama.generate({
    model: model,
    prompt: prompt,
    stream: false
  })
  verbose('llm:generate rag.ask response', response.response.slice(0, 200))

  return response.response
}
