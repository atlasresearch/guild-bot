import { describe, expect, it, vi } from 'vitest'

vi.mock('@guildbot/media', () => ({
  audioToTranscript: vi.fn().mockResolvedValue('rec-abc123'),
}))

import handler from './handler'

describe('transcribe-audio handler', () => {
  it('returns recording id from audioToTranscript', async () => {
    const result = await handler({ url: 'https://example.com/audio.mp3' }, {})
    expect(result.success).toBe(true)
    expect((result.data as any).recording_id).toBe('rec-abc123')
  })

  it('passes url and onProgress to audioToTranscript', async () => {
    const { audioToTranscript } = await import('@guildbot/media')
    const onProgress = vi.fn()
    await handler({ url: 'https://yt.com/watch?v=123' }, { onProgress })
    expect(audioToTranscript).toHaveBeenCalledWith(expect.any(String), 'https://yt.com/watch?v=123', onProgress)
  })
})
