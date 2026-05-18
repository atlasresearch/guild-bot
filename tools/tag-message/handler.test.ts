import { describe, expect, it, vi } from 'vitest'

vi.mock('@guildbot/message-processor', () => ({
  addTags: vi.fn().mockResolvedValue(undefined),
}))

import handler from './handler'

describe('tag-message handler', () => {
  it('calls addTags and returns success', async () => {
    const result = await handler({ message_id: 'msg-1', tags: ['important', 'review'] }, {})
    expect(result.success).toBe(true)
    expect((result.data as any).message_id).toBe('msg-1')
    expect((result.data as any).tags).toEqual(['important', 'review'])
  })

  it('passes correct args to addTags', async () => {
    const { addTags } = await import('@guildbot/message-processor')
    await handler({ message_id: 'msg-2', tags: ['a'] }, {})
    expect(addTags).toHaveBeenCalledWith('msg-2', ['a'])
  })
})
