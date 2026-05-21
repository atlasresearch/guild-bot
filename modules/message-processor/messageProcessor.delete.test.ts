import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Collection } from 'discord.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as db from '@guildbot/database'
import type { IDBSchema } from '@guildbot/database'
import * as processor from './messageProcessor'

// use a temporary directory per test run
describe('Message Processor Deletion', () => {
  const testRecord: IDBSchema = {
    id: 'msg_to_delete',
    guild_id: 'guild_1',
    channel_id: 'chan_1',
    user_id: 'user_1',
    content: 'Content',
    timestamp: 1000,
    metadata: '{}',
    tags: ['dummy'],
    vector: Array(768).fill(0.1)
  }

  beforeEach(async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'guildbot-mp-del-test-'))
    await db.initDB(join(tmpDir, 'db'))
    await db.upsert(testRecord)
  })

  afterEach(async () => {
    await db.dropDB()
  })

  it('should delete a message via processor', async () => {
    await processor.deleteMessage('msg_to_delete')

    const msg = await db.getMessage('msg_to_delete')
    expect(msg).toBeNull()
  })

  it('should detect deleted messages during sync', async () => {
    await db.upsert({ ...testRecord, id: 'msg_1', timestamp: 1000 })
    await db.upsert({ ...testRecord, id: 'msg_2', timestamp: 2000 })
    await db.upsert({ ...testRecord, id: 'msg_3', timestamp: 3000 })

    const mockMessages = new Collection<string, any>()
    mockMessages.set('msg_1', {
      id: 'msg_1',
      createdTimestamp: 1000,
      author: { bot: false },
      content: 'Alive',
      attachments: { size: 0, map: () => [] }
    })
    mockMessages.set('msg_3', {
      id: 'msg_3',
      createdTimestamp: 3000,
      author: { bot: false },
      content: 'Alive',
      attachments: { size: 0, map: () => [] }
    })

    const mockChannel: any = {
      id: 'chan_1',
      isTextBased: () => true,
      messages: {
        fetch: vi.fn().mockResolvedValue(mockMessages)
      }
    }

    await processor.syncChannel(mockChannel)

    const msg1 = await db.getMessage('msg_1')
    const msg2 = await db.getMessage('msg_2')
    const msg3 = await db.getMessage('msg_3')

    expect(msg1).toBeDefined()
    expect(msg3).toBeDefined()
    expect(msg2).toBeNull()
  })
})
