// src/services/embedding.ts
import ollama from 'ollama'
import { verbose } from '@guildbot/interfaces'

export const getEmbedding = async (text: string, model: string = 'nomic-embed-text'): Promise<number[]> => {
  if (!text || text.trim().length === 0) return []
  verbose('llm:embed', { model, textLength: text.length })
  const response = await ollama.embeddings({
    model: model,
    prompt: text
  })
  verbose('llm:embed response', { model, dimensions: response.embedding.length })
  return response.embedding
}
