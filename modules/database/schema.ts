// src/database/schema.ts
export interface IDBSchema {
  id: string
  guild_id: string
  channel_id: string
  user_id: string
  content: string
  timestamp: number
  metadata: string // JSON string
  tags: string[]
  vector: number[]
  [key: string]: unknown
}
