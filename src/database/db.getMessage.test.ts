
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as db from './db'
import { IDBSchema } from './schema'

describe('Database getMessage', () => {
  const testRecord: IDBSchema = {
    id: 'msg_target',
    guild_id: 'guild_1',
    channel_id: 'chan_1',
    user_id: 'user_1',
    content: 'Target message',
    timestamp: Date.now(),
    metadata: '{}',
    tags: ['initial'],
    vector: Array(768).fill(0.1)
  }

  beforeEach(async () => {
    await db.initDB('test')
    await db.upsert(testRecord)
  })

  afterEach(async () => {
    await db.dropDB()
  })

  it('should retrieve a message by id', async () => {
    // @ts-ignore - function not yet implemented
    const msg = await db.getMessage('msg_target')
    expect(msg).toBeDefined()
    expect(msg?.content).toBe('Target message')
  })

  it('should return null for non-existent message', async () => {
    // @ts-ignore
    const msg = await db.getMessage('msg_missing')
    expect(msg).toBeNull()
  })
})
