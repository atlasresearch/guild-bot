
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as db from './db'
import { IDBSchema } from './schema'

describe('Database deleteMessage', () => {
  const testRecord: IDBSchema = {
    id: 'msg_to_delete',
    guild_id: 'guild_1',
    channel_id: 'chan_1',
    user_id: 'user_1',
    content: 'Content to delete',
    timestamp: Date.now(),
    metadata: '{}',
    tags: ['dummy'],
    vector: Array(768).fill(0.1)
  }

  beforeEach(async () => {
    await db.initDB('test')
    await db.upsert(testRecord)
  })

  afterEach(async () => {
    await db.dropDB()
  })

  it('should delete a message by id', async () => {
    // Verify it exists
    const before = await db.getMessage('msg_to_delete')
    expect(before).toBeDefined()

    // @ts-ignore - function to be implemented
    await db.deleteMessage('msg_to_delete')

    // Verify it is gone
    const after = await db.getMessage('msg_to_delete')
    expect(after).toBeNull()
  })

  it('should be idempotent (deleting non-existent message is fine)', async () => {
    // @ts-ignore
    await db.deleteMessage('msg_non_existent')
  })
})
