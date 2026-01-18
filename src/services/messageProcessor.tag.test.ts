
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as db from '../database/db'
import * as processor from './messageProcessor'
import { IDBSchema } from '../database/schema'

describe('Message Processor Tagging', () => {
    const testRecord: IDBSchema = {
        id: 'msg_to_tag',
        guild_id: 'guild_1',
        channel_id: 'chan_1',
        user_id: 'user_1',
        content: 'Content to tag',
        timestamp: Date.now(),
        metadata: '{}',
        tags: ['original'],
        vector: Array(768).fill(0.1)
    }

    beforeEach(async () => {
        await db.initDB('test')
        await db.upsert(testRecord)
    })

    afterEach(async () => {
        await db.dropDB()
    })

    it('should add new tags to existing message', async () => {
        // @ts-ignore
        await processor.addTags('msg_to_tag', ['new', 'fancy'])
        
        const msg = await db.getMessage('msg_to_tag')
        expect(msg?.tags).toContain('original')
        expect(msg?.tags).toContain('new')
        expect(msg?.tags).toContain('fancy')
        expect(msg?.tags.length).toBe(3)
    })

    it('should not add duplicate tags', async () => {
        // @ts-ignore
        await processor.addTags('msg_to_tag', ['original', 'new'])
        
        const msg = await db.getMessage('msg_to_tag')
        expect(msg?.tags).toContain('original')
        expect(msg?.tags).toContain('new')
        expect(msg?.tags.length).toBe(2)
    })

    it('should throw error if message not found', async () => {
        // @ts-ignore
        await expect(processor.addTags('non_existent', ['tag'])).rejects.toThrow('Message not found')
    })

    it('should remove tags from existing message', async () => {
        // Setup message with tags
        const id = 'msg_to_untag'
        const record = { ...testRecord, id, tags: ['keep', 'remove_me'] }
        await db.upsert(record)

        // @ts-ignore
        await processor.removeTags(id, ['remove_me'])
        
        const msg = await db.getMessage(id)
        expect(msg?.tags).toContain('keep')
        expect(msg?.tags).not.toContain('remove_me')
        expect(msg?.tags.length).toBe(1)
    })

    it('should handle removing non-existent tags gracefully', async () => {
        const id = 'msg_untag_safe'
        const record = { ...testRecord, id, tags: ['keep'] }
        await db.upsert(record)

        // @ts-ignore
        await processor.removeTags(id, ['not_there'])
        
        const msg = await db.getMessage(id)
        expect(msg?.tags).toContain('keep')
        expect(msg?.tags.length).toBe(1)
    })
})
