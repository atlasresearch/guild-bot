// src/services/messageProcessor.ts
import { Collection, Message, TextBasedChannel } from 'discord.js'
import * as db from '../database/db'
import { IDBSchema } from '../database/schema'
import { getEmbedding } from './embedding'

export interface IProcessableMessage {
  id: string
  guildId: string | null
  channelId: string
  authorId: string
  content: string
  createdTimestamp: number
  type?: string // 'default' | 'transcription'
}

export const processMessage = async (msg: IProcessableMessage, isTranscription: boolean = false) => {
  if (!msg.guildId) return

  const tags: string[] = []

  if (msg.content.length < 50) tags.push('short')
  else tags.push('long')

  if (msg.content.includes('http://') || msg.content.includes('https://')) {
    tags.push('link')
  }

  if (isTranscription) {
    tags.push('transcription')
  }

  const vector = await getEmbedding(msg.content)

  const record: IDBSchema = {
    id: msg.id,
    guild_id: msg.guildId,
    channel_id: msg.channelId,
    user_id: msg.authorId,
    content: msg.content,
    timestamp: msg.createdTimestamp,
    metadata: JSON.stringify({ type: msg.type || 'default' }),
    tags: tags,
    vector: vector
  }

  await db.upsert(record)
}

export const processDiscordMessage = async (msg: Message) => {
  if (!msg.content && msg.attachments.size === 0) return

  let content = msg.content
  if (msg.attachments.size > 0) {
    const urls = msg.attachments.map((a) => a.url).join('\n')
    content = content ? content + '\n' + urls : urls
  }

  const processable: IProcessableMessage = {
    id: msg.id,
    guildId: msg.guild?.id || null,
    channelId: msg.channelId,
    authorId: msg.author.id,
    content: content,
    createdTimestamp: msg.createdTimestamp
  }
  await processMessage(processable)
}

export const syncChannel = async (channel: TextBasedChannel) => {
  if (!channel.isTextBased()) return

  const lastKnown = await db.getLatestMessage(channel.id)

  let fetchedMessages: Collection<string, Message<boolean>> | Message<boolean>[]

  if (lastKnown) {
    try {
      fetchedMessages = await channel.messages.fetch({ after: lastKnown.id, limit: 100 })
    } catch {
      fetchedMessages = await channel.messages.fetch({ limit: 50 })
    }
  } else {
    fetchedMessages = await channel.messages.fetch({ limit: 50 })
  }

  const messages = Array.from(fetchedMessages.values()).sort((a, b) => a.createdTimestamp - b.createdTimestamp)

  for (const msg of messages) {
    if (msg.author.bot) continue
    await processDiscordMessage(msg)
  }

  console.log(`Synced ${messages.length} messages for channel ${channel.id}`)
}

export const processHistory = async (messages: IProcessableMessage[]) => {
  for (const msg of messages) {
    await processMessage(msg)
  }
}

export const addTags = async (id: string, tags: string[]) => {
  const msg = await db.getMessage(id)
  if (!msg) {
    throw new Error('Message not found')
  }

  const newTags = Array.from(new Set([...msg.tags, ...tags]))
  msg.tags = newTags
  
  await db.upsert(msg)
}

export const removeTags = async (id: string, tags: string[]) => {
  const msg = await db.getMessage(id)
  if (!msg) {
    throw new Error('Message not found')
  }

  const tagSet = new Set(msg.tags)
  tags.forEach(t => tagSet.delete(t))
  
  msg.tags = Array.from(tagSet)
  
  await db.upsert(msg)
}
