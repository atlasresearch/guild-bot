import { describe, expect, it, vi } from 'vitest'

vi.mock('@guildbot/rag', () => ({
  search: vi.fn().mockResolvedValue([
    { id: 'msg-1', content: 'hello', user_id: 'u1', timestamp: 1000, channel_id: 'c1' },
    { id: 'msg-2', content: 'world', user_id: 'u2', timestamp: 2000, channel_id: 'c2' },
  ]),
}))

import handler from './handler'

describe('search-messages handler', () => {
  it('returns search results from rag.search', async () => {
    const result = await handler({ query: 'hello' }, { guildId: 'g1' })
    expect(result.success).toBe(true)
    expect(Array.isArray(result.data)).toBe(true)
    expect((result.data as any[]).length).toBe(2)
  })

  it('passes limit parameter', async () => {
    const { search } = await import('@guildbot/rag')
    await handler({ query: 'test', limit: 10 }, { guildId: 'g1' })
    expect(search).toHaveBeenCalledWith('g1', 'test', 10)
  })

  it('defaults limit to 5', async () => {
    const { search } = await import('@guildbot/rag')
    await handler({ query: 'test' }, { guildId: 'g1' })
    expect(search).toHaveBeenCalledWith('g1', 'test', 5)
  })
})
