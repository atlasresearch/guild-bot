// src/services/messageProcessor.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as db from '../database/db'
import * as embedding from './embedding'
import * as messageProcessor from './messageProcessor'
import { IProcessableMessage } from './messageProcessor'

// Mocks
vi.mock('../database/db', () => ({
  upsert: vi.fn()
}))

vi.mock('./embedding', () => ({
  getEmbedding: vi.fn()
}))

describe('MessageProcessor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(embedding.getEmbedding as any).mockResolvedValue([0.1, 0.2])
  })

  it('should process a generic message correctly', async () => {
    const msg: IProcessableMessage = {
      id: '1',
      guildId: 'g1',
      channelId: 'c1',
      authorId: 'u1',
      content: 'Hello world',
      createdTimestamp: 12345
    }

    await messageProcessor.processMessage(msg)

    expect(embedding.getEmbedding).toHaveBeenCalledWith('Hello world')
    expect(db.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: '1',
        tags: expect.arrayContaining(['short']),
        vector: [0.1, 0.2]
      })
    )
  })

  it('should add link tag', async () => {
    const msg: IProcessableMessage = {
      id: '2',
      guildId: 'g1',
      channelId: 'c1',
      authorId: 'u1',
      content: 'Check this https://google.com',
      createdTimestamp: 12345
    }

    await messageProcessor.processMessage(msg)

    expect(db.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        tags: expect.arrayContaining(['short', 'link'])
      })
    )
  })

  it('should add transcription tag', async () => {
    const msg: IProcessableMessage = {
      id: '3',
      guildId: 'g1',
      channelId: 'c1',
      authorId: 'u1',
      content: 'Audio log content very long content indeed to make it long enough',
      createdTimestamp: 12345
    }

    await messageProcessor.processMessage(msg, true)

    expect(db.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        tags: expect.arrayContaining(['transcription'])
      })
    )
  })
})
