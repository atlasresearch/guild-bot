import { describe, expect, it, vi } from 'vitest'

vi.mock('@guildbot/media', () => ({
  downloadYoutubeSingleWithInfo: vi.fn().mockResolvedValue('/tmp/audio.mp3'),
}))

import handler from './handler'

describe('download-youtube handler', () => {
  it('returns audio path from downloadYoutubeSingleWithInfo', async () => {
    const result = await handler({ url: 'https://youtube.com/watch?v=abc' }, {})
    expect(result.success).toBe(true)
    expect((result.data as any).audio_path).toBe('/tmp/audio.mp3')
  })

  it('passes url to downloadYoutubeSingleWithInfo', async () => {
    const { downloadYoutubeSingleWithInfo } = await import('@guildbot/media')
    await handler({ url: 'https://youtube.com/watch?v=xyz' }, {})
    expect(downloadYoutubeSingleWithInfo).toHaveBeenCalledWith('https://youtube.com/watch?v=xyz', '')
  })
})
