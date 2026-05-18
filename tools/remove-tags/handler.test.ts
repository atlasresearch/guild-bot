import { describe, expect, it, vi } from 'vitest'

vi.mock('@guildbot/message-processor', () => ({
  removeTags: vi.fn().mockResolvedValue(undefined),
}))

import handler from './handler'

describe('remove-tags handler', () => {
  it('calls removeTags and returns success', async () => {
    const result = await handler({ message_id: 'msg-1', tags: ['old-tag'] }, {})
    expect(result.success).toBe(true)
    expect((result.data as any).message_id).toBe('msg-1')
    expect((result.data as any).tags).toEqual(['old-tag'])
  })

  it('passes correct args to removeTags', async () => {
    const { removeTags } = await import('@guildbot/message-processor')
    await handler({ message_id: 'msg-2', tags: ['a', 'b'] }, {})
    expect(removeTags).toHaveBeenCalledWith('msg-2', ['a', 'b'])
  })
})
