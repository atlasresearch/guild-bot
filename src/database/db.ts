// src/database/db.ts
import * as lancedb from '@lancedb/lancedb'
import fs from 'fs'
import path from 'path'
import { IDBSchema } from './schema'

let dbInstance: lancedb.Connection | null = null
let dbPath: string = ''

export const initDB = async (env: string = process.env.NODE_ENV || 'development') => {
  const basePath = process.cwd()
  let relativePath = '.lancedb'

  if (env === 'test') relativePath = '.lancedb_test'
  if (env === 'production') relativePath = '.lancedb_prod'
  if (process.env.DB_PATH) relativePath = process.env.DB_PATH

  dbPath = path.join(basePath, relativePath)

  if (!fs.existsSync(dbPath)) {
    fs.mkdirSync(dbPath, { recursive: true })
  }

  dbInstance = await lancedb.connect(dbPath)
}

const getTable = async () => {
  if (!dbInstance) await initDB()
  if (!dbInstance) throw new Error('Database not initialized')

  const tableNames = await dbInstance.tableNames()
  if (tableNames.includes('messages')) {
    return await dbInstance.openTable('messages')
  }
  return null
}

export const upsert = async (record: IDBSchema) => {
  const table = await getTable()
  if (!table) {
    if (!dbInstance) throw new Error('DB not init')
    await dbInstance.createTable('messages', [record], { existOk: true })
    return
  }

  await table.delete(`id = '${record.id}'`)
  await table.add([record])
}

export const searchVector = async (queryVector: number[], limit: number = 5, filter?: string) => {
  const table = await getTable()
  if (!table) return []

  let query = table.search(queryVector).limit(limit)
  if (filter) {
    query = query.where(filter)
  }
  return await query.toArray()
}

export const getSince = async (channelId: string, timestamp: number) => {
  const table = await getTable()
  if (!table) return []
  return await table.query().where(`channel_id = '${channelId}' AND timestamp > ${timestamp}`).toArray()
}

export const getLatestMessage = async (channelId: string): Promise<{ id: string; timestamp: number } | null> => {
  const table = await getTable()
  if (!table) return null
  try {
    const results = await table.query().where(`channel_id = '${channelId}'`).toArray()
    if (results.length === 0) return null

    results.sort((a, b) => (b.timestamp as number) - (a.timestamp as number))

    return { id: results[0].id as string, timestamp: results[0].timestamp as number }
  } catch {
    return null
  }
}

export const dropDB = async () => {
  if (dbPath && fs.existsSync(dbPath)) {
    fs.rmSync(dbPath, { recursive: true, force: true })
  }
  dbInstance = null
}
