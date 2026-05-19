import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as db from './db'
import { IDBSchema } from './schema'

// R5.1, R5.2: tests use a temporary directory, never ~/.guildbot-*
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
    const tmpDir = await mkdtemp(join(tmpdir(), 'guildbot-db-del-test-'))
    await db.initDB(join(tmpDir, 'db'))
    await db.upsert(testRecord)
  })

  afterEach(async () => {
    await db.dropDB()
  })

  it('should delete a message by id', async () => {
    const before = await db.getMessage('msg_to_delete')
    expect(before).toBeDefined()

    await db.deleteMessage('msg_to_delete')

    const after = await db.getMessage('msg_to_delete')
    expect(after).toBeNull()
  })

  it('should be idempotent (deleting non-existent message is fine)', async () => {
    await db.deleteMessage('msg_non_existent')
  })
})
