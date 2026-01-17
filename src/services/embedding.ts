// src/services/embedding.ts
import ollama from 'ollama'

export const getEmbedding = async (text: string, model: string = 'nomic-embed-text'): Promise<number[]> => {
  if (!text || text.trim().length === 0) return []
  const response = await ollama.embeddings({
    model: model,
    prompt: text
  })
  return response.embedding
}
