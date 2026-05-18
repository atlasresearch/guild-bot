import { describe, expect, it, vi } from 'vitest'

vi.mock('@guildbot/rag', () => ({
  ask: vi.fn().mockResolvedValue('The answer is 42.'),
}))

import handler from './handler'

describe('ask-knowledge-base handler', () => {
  it('returns answer from rag.ask', async () => {
    const result = await handler({ question: 'What is the meaning of life?' }, { guildId: 'g1' })
    expect(result.success).toBe(true)
    expect((result.data as any).answer).toBe('The answer is 42.')
  })

  it('passes guildId to rag.ask', async () => {
    const { ask } = await import('@guildbot/rag')
    await handler({ question: 'test' }, { guildId: 'guild-123' })
    expect(ask).toHaveBeenCalledWith('guild-123', 'test')
  })

  it('uses empty string for missing guildId', async () => {
    const { ask } = await import('@guildbot/rag')
    await handler({ question: 'test' }, {})
    expect(ask).toHaveBeenCalledWith('', 'test')
  })
})
