import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as db from '@guildbot/database'
import * as embedding from '@guildbot/embedding'

// Mock the LLM boundary; internal modules run for real.
const { mockChat } = vi.hoisted(() => ({ mockChat: vi.fn() }))
vi.mock('@guildbot/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@guildbot/llm')>()
  return { ...actual, chat: mockChat }
})

vi.mock('@guildbot/database', () => ({
  searchVector: vi.fn(),
}))

vi.mock('@guildbot/embedding', () => ({
  getEmbedding: vi.fn(),
}))

import * as ragService from './rag'

describe('RAGService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(embedding.getEmbedding as any).mockResolvedValue([0.1])
  })

  it('searches using the embedding vector', async () => {
    ;(db.searchVector as any).mockResolvedValue([{ content: 'match' }])
    const results = await ragService.search('g1', 'query')

    expect(embedding.getEmbedding).toHaveBeenCalledWith('query')
    expect(db.searchVector).toHaveBeenCalled()
    expect(results[0].content).toBe('match')
  })

  it('asks a question using retrieved context and returns the LLM content', async () => {
    ;(db.searchVector as any).mockResolvedValue([
      { timestamp: 1000, user_id: 'u1', content: 'The secret code is 1234' },
    ])
    mockChat.mockResolvedValue({
      content: 'The code is 1234',
      toolCalls: [],
      model: 'qwen3.6',
      finishReason: 'stop',
    })

    const answer = await ragService.ask('g1', 'What is the code?')

    expect(mockChat).toHaveBeenCalledOnce()
    const callArgs = mockChat.mock.calls[0][0]
    expect(callArgs.messages[0].role).toBe('user')
    expect(callArgs.messages[0].content).toContain('The secret code is 1234')
    expect(answer).toBe('The code is 1234')
  })
})
