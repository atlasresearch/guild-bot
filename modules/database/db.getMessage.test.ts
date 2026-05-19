import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as db from './db'
import { IDBSchema } from './schema'

// R5.1, R5.2: tests use a temporary directory, never ~/.guildbot-*
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
    const tmpDir = await mkdtemp(join(tmpdir(), 'guildbot-db-get-test-'))
    await db.initDB(join(tmpDir, 'db'))
    await db.upsert(testRecord)
  })

  afterEach(async () => {
    await db.dropDB()
  })

  it('should retrieve a message by id', async () => {
    const msg = await db.getMessage('msg_target')
    expect(msg).toBeDefined()
    expect(msg?.content).toBe('Target message')
  })

  it('should return null for non-existent message', async () => {
    const msg = await db.getMessage('msg_missing')
    expect(msg).toBeNull()
  })
})
