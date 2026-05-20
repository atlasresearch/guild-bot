import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockEmbed } = vi.hoisted(() => ({ mockEmbed: vi.fn() }))
vi.mock('@guildbot/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@guildbot/llm')>()
  return { ...actual, embed: mockEmbed }
})

import * as embedding from './embedding'

describe('embedding', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('delegates to @guildbot/llm embed() with the supplied model', async () => {
    mockEmbed.mockResolvedValue([0.1, 0.2, 0.3])
    const result = await embedding.getEmbedding('hello world', 'test-model')

    expect(mockEmbed).toHaveBeenCalledWith('hello world', { model: 'test-model' })
    expect(result).toEqual([0.1, 0.2, 0.3])
  })

  it('passes undefined model when omitted, letting llm pick the active embed model', async () => {
    mockEmbed.mockResolvedValue([0.5])
    await embedding.getEmbedding('hi')
    expect(mockEmbed).toHaveBeenCalledWith('hi', { model: undefined })
  })
})
