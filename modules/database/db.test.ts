import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as db from './db'
import { IDBSchema } from './schema'

// R5.1, R5.2: tests use a temporary directory, never ~/.guildbot-*
describe('Database', () => {
  const testRecord: IDBSchema = {
    id: 'msg_1',
    guild_id: 'guild_1',
    channel_id: 'chan_1',
    user_id: 'user_1',
    content: 'Hello world',
    timestamp: Date.now(),
    metadata: '{}',
    tags: ['short'],
    vector: Array(768).fill(0.1)
  }

  beforeEach(async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'guildbot-db-test-'))
    await db.initDB(join(tmpDir, 'db'))
  })

  afterEach(async () => {
    await db.dropDB()
  })

  it('should create table and insert record', async () => {
    await db.upsert(testRecord)

    const results = await db.getSince('chan_1', 0)
    expect(results.length).toBe(1)
  })

  it('should upsert (replace) record', async () => {
    await db.upsert(testRecord)

    const updatedRecord = { ...testRecord, content: 'Updated content' }
    await db.upsert(updatedRecord)

    const results = await db.getSince('chan_1', 0)
    expect(results.length).toBe(1)
    expect(results[0].content).toBe('Updated content')
  })

  it('should search by vector', async () => {
    await db.upsert(testRecord)
    const results = await db.searchVector(testRecord.vector, 1)
    expect(results.length).toBe(1)
    expect(results[0].id).toBe(testRecord.id)
  })

  it('should get messages since timestamp', async () => {
    const oldMsg = { ...testRecord, id: 'old', timestamp: 100 }
    const newMsg = { ...testRecord, id: 'new', timestamp: 200 }

    await db.upsert(oldMsg)
    await db.upsert(newMsg)

    const results = await db.getSince('chan_1', 150)
    expect(results.length).toBe(1)
    expect(results[0].id).toBe('new')
  })
})
