// src/services/rag.test.ts
import ollama from 'ollama'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as db from '../database/db'
import * as embedding from './embedding'
import * as ragService from './rag'

vi.mock('ollama', () => ({
  default: {
    generate: vi.fn()
  }
}))

// Mocks
vi.mock('../database/db', () => ({
  searchVector: vi.fn()
}))

vi.mock('./embedding', () => ({
  getEmbedding: vi.fn()
}))

describe('RAGService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(embedding.getEmbedding as any).mockResolvedValue([0.1])
  })

  it('should search using embedding', async () => {
    ;(db.searchVector as any).mockResolvedValue([{ content: 'match' }])
    const results = await ragService.search('g1', 'query')

    expect(embedding.getEmbedding).toHaveBeenCalledWith('query')
    expect(db.searchVector).toHaveBeenCalled()
    expect(results[0].content).toBe('match')
  })

  it('should ask question and use context', async () => {
    ;(db.searchVector as any).mockResolvedValue([
      { timestamp: 1000, user_id: 'u1', content: 'The secret code is 1234' }
    ])
    ;(ollama.generate as any).mockResolvedValue({ response: 'The code is 1234' })

    const answer = await ragService.ask('g1', 'What is the code?')

    expect(db.searchVector).toHaveBeenCalled()
    expect(ollama.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('The secret code is 1234')
      })
    )
    expect(answer).toBe('The code is 1234')
  })
})
