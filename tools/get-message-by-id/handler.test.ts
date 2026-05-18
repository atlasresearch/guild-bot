import { describe, expect, it, vi } from 'vitest'

vi.mock('@guildbot/database', () => ({
  getMessage: vi.fn().mockImplementation(async (id: string) => {
    if (id === 'found-id') return { id: 'found-id', content: 'hello', user_id: 'u1', timestamp: 1000, tags: ['tag1'] }
    return null
  }),
}))

import handler from './handler'

describe('get-message-by-id handler', () => {
  it('returns message when found', async () => {
    const result = await handler({ message_id: 'found-id' }, {})
    expect(result.success).toBe(true)
    expect((result.data as any).content).toBe('hello')
  })

  it('returns failure when message not found', async () => {
    const result = await handler({ message_id: 'missing-id' }, {})
    expect(result.success).toBe(false)
    expect((result.data as any).error).toContain('missing-id')
  })
})
