// RAG: semantic search + LLM Q&A over the indexed message store.
import { chat } from '@guildbot/llm'
import * as db from '@guildbot/database'
import { getEmbedding } from '@guildbot/embedding'

export const search = async (guildId: string, query: string, limit: number = 5) => {
  const queryVector = await getEmbedding(query)
  const filter = `guild_id = '${guildId}'`

  const results = await db.searchVector(queryVector, limit, filter)
  return results
}

export const ask = async (guildId: string, question: string, model?: string) => {
  const results = await search(guildId, question, 10)

  let context = 'Here are some relevant messages from the history:\n'
  results.forEach((r: any) => {
    context += `[${new Date(r.timestamp).toISOString()}] ${r.user_id}: ${r.content}\n`
  })

  const prompt = `Context:\n${context}\n\nQuestion: ${question}\n\nAnswer the question based on the context provided.`

  const response = await chat({
    model,
    messages: [{ role: 'user', content: prompt }],
  })
  return response.content
}
