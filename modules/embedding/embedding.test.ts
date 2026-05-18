// src/services/embedding.test.ts
import ollama from 'ollama'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as embedding from './embedding'

vi.mock('ollama', () => ({
  default: {
    embeddings: vi.fn()
  }
}))

describe('EmbeddingService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should call ollama.embeddings with correct parameters', async () => {
    ;(ollama.embeddings as any).mockResolvedValue({ embedding: [0.1, 0.2, 0.3] })

    const result = await embedding.getEmbedding('hello world', 'test-model')

    expect(ollama.embeddings).toHaveBeenCalledWith({
      model: 'test-model',
      prompt: 'hello world'
    })
    expect(result).toEqual([0.1, 0.2, 0.3])
  })

  it('should return empty array for empty text', async () => {
    const result = await embedding.getEmbedding('')
    expect(result).toEqual([])
    expect(ollama.embeddings).not.toHaveBeenCalled()
  })
})
