
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as db from '../database/db'
import * as processor from './messageProcessor'
import { IDBSchema } from '../database/schema'
import { Collection } from 'discord.js'

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
        await db.initDB('test')
        await db.upsert(testRecord)
    })

    afterEach(async () => {
        await db.dropDB()
    })

    it('should delete a message via processor', async () => {
        // @ts-ignore
        await processor.deleteMessage('msg_to_delete')
        
        const msg = await db.getMessage('msg_to_delete')
        expect(msg).toBeNull()
    })

    it('should detect deleted messages during sync', async () => {
        // Setup DB state: 3 messages
        // msg_1: ts 1000
        // msg_2: ts 2000 (To be deleted)
        // msg_3: ts 3000
        
        await db.upsert({ ...testRecord, id: 'msg_1', timestamp: 1000 })
        await db.upsert({ ...testRecord, id: 'msg_2', timestamp: 2000 })
        await db.upsert({ ...testRecord, id: 'msg_3', timestamp: 3000 })

        // Mock Discord Channel
        // Discord only returns msg_1 and msg_3 (msg_2 is gone)
        const mockMessages = new Collection<string, any>()
        mockMessages.set('msg_1', { id: 'msg_1', createdTimestamp: 1000, author: { bot: false }, content: 'Alive', attachments: { size: 0, map: () => [] } })
        mockMessages.set('msg_3', { id: 'msg_3', createdTimestamp: 3000, author: { bot: false }, content: 'Alive', attachments: { size: 0, map: () => [] } })

        const mockChannel: any = {
            id: 'chan_1',
            isTextBased: () => true,
            messages: {
                fetch: vi.fn().mockResolvedValue(mockMessages)
            }
        }

        // We mock db.getLatestMessage to force a fetch of some range, 
        // OR we rely on syncChannel logic.
        // syncChannel fetches based on lastKnown or limit 50.
        // If we have data, it fetches 'after: lastKnown.id'.
        // If we want to check for deletions, we might need to fetch 'limit: X' regardless or handle it differently.
        // Current syncChannel logic:
        // if (lastKnown) fetches after lastKnown.
        // This assumes append-only history. It won't see deletions of OLDER messages if it only looks forward.
        // Implicitly, the user requirement "boot sync" implies checking for deletions.
        // We might need to change syncChannel to fetch latest N messages and compare, rather than just "after last known".
        // OR do a hybrid: upsert forward, verify backward/window.
        
        // Let's assume we implement a logic that verifies the window defined by the fetched messages.
        
        await processor.syncChannel(mockChannel)

        // Check DB
        const msg1 = await db.getMessage('msg_1')
        const msg2 = await db.getMessage('msg_2')
        const msg3 = await db.getMessage('msg_3')

        expect(msg1).toBeDefined()
        expect(msg3).toBeDefined()
        expect(msg2).toBeNull() // Should be deleted
    })
})
